import 'dotenv/config';
import { loadEnv } from '../src/config/env.js';

const c = loadEnv();
console.log(
  JSON.stringify(
    {
      port: c.env.PORT,
      nodeEnv: c.env.NODE_ENV,
      openrouterKeys: c.openrouterKeys.length,
      openai: !!c.env.OPENAI_API_KEY,
      zai: !!c.env.ZAI_API_KEY,
      opencode: !!c.env.OPENCODE_API_KEY,
      opencodeModel: c.env.OPENCODE_MODEL,
      walkAlias: c.env.WALK_ALIAS,
      forceFree: c.env.FORCE_FREE,
    },
    null,
    2,
  ),
);
