import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { ethers } from 'ethers';
import { KMSClient } from '@aws-sdk/client-kms';
import { AwsKmsSigner } from '@aws/kms-signer';

const requiredEnv = ['RPC_URL', 'AWS_REGION', 'KMS_KEY_ID', 'API_KEY', 'TOKEN_ADDRESS'];
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

const { RPC_URL, AWS_REGION, KMS_KEY_ID, API_KEY, TOKEN_ADDRESS } = process.env;
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  const start = new Date().toISOString();
  const safeBody = (() => {
    try {
      return JSON.stringify(req.body ?? {});
    } catch {
      return '"[unserializable]"';
    }
  })();
  console.log(`[${start}] ${req.ip} ${req.method} ${req.originalUrl} body=${safeBody}`);
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    const stamp = new Date().toISOString();
    const safePayload = (() => {
      try {
        return JSON.stringify(payload ?? {});
      } catch {
        return '"[unserializable]"';
      }
    })();
    console.log(`[${stamp}] response ${req.method} ${req.originalUrl} status=${res.statusCode} body=${safePayload}`);
    return originalJson(payload);
  };
  next();
});

app.use(rateLimit({ windowMs: 60_000, max: 5, message: { ok: false, error: 'Too many requests' } }));

const provider = new ethers.JsonRpcProvider(RPC_URL);
const kmsClient = new KMSClient({ region: AWS_REGION });
const signer = new AwsKmsSigner({ keyId: KMS_KEY_ID, kmsClient, provider });
const token = new ethers.Contract(
  TOKEN_ADDRESS,
  ['function transfer(address to, uint256 value) public returns (bool)'],
  signer
);

const extractKey = (value = '') => {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith('bearer ')
    ? trimmed.slice(7).trim()
    : trimmed;
};

app.use((req, res, next) => {
  if (extractKey(req.get('authorization')) !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

app.post('/api/payout', async (req, res) => {
  const { crystalId, player, wallet } = req.body || {};
  if (!crystalId || !player || !wallet) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ ok: false, error: 'Invalid wallet address' });
  }
  try {
    const amount = ethers.parseUnits('50', 18);
    const tx = await token.transfer(wallet, amount);
    const receipt = await tx.wait(1);
    return res.json({ ok: true, txHash: receipt.hash });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] payout error`, error.message);
    return res.status(500).json({ ok: false, error: 'Payout failed' });
  }
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.listen(port, () => {
  console.log(`[${new Date().toISOString()}] Server listening on port ${port}`);
});
