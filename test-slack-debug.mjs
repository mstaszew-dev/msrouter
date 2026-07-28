import 'dotenv/config';
import { loadEnv } from './src/config/env.js';
const { env } = loadEnv();
console.log('SLACK_BOT_TOKEN:', env.SLACK_BOT_TOKEN ? '***present***' : 'missing');
console.log('SLACK_CHANNEL:', env.SLACK_CHANNEL || 'missing');
process.exit(0);
