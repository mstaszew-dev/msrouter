import 'dotenv/config';
import { loadEnv } from '../src/config/env.js';
import { extraRoutingEntries } from '../src/providers/extras.js';

const c = loadEnv();
const e = c.env;
// Diagnostic snapshot of the live provider set (what the chain will actually
// route to), not the raw env surface: extras are listed with their configured
// models, parked providers with their state.
// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      port: e.PORT,
      nodeEnv: e.NODE_ENV,
      openrouterKeys: c.openrouterKeys.length,
      openai: !!e.OPENAI_API_KEY,
      zai: !!e.ZAI_API_KEY,
      tokenrouter: !!e.TOKENROUTER_API_KEY,
      opencodego: !!e.OPENCODEGO_API_KEY,
      extras: extraRoutingEntries().map((x) => `${x.provider}:${x.model}`),
      local: e.LOCAL_ENABLED,
      lmstudio: e.LMSTUDIO_ENABLED,
      laptop: e.LAPTOP_ENABLED,
      kafkaEnabled: e.KAFKA_ENABLED,
      directorAutostart: e.DIRECTOR_AUTOSTART,
      walkAlias: e.WALK_ALIAS,
      forceFree: e.FORCE_FREE,
    },
    null,
    2,
  ),
);
