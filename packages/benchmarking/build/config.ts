import { config as conf } from 'dotenv';

function buildEnv<T extends Record<string, string>>(props: T): Record<keyof T, string> {
  conf();
  conf({ path: '../.env'});
  conf({ path: '../../.env'});
  conf({ path: '../../../.env'});
  conf({ path: '../../../../.env'});
  conf({ path: '../../../../../.env'});
  const env:Partial<Record<keyof typeof props, string | number>> = {};
  for (const k in props) {
    env[k] = process.env[props[k]];
    if (env[k] === undefined || env[k] === null) {
      throw new Error("Missing env var: " + props[k]);
    }
  }
  return env as Record<keyof T, string>;
}

const env = buildEnv({
  port: 'STREAMERSON_GATEWAY_PORT',
  host: 'STREAMERSON_GATEWAY_HOST',
  topic: 'STREAMERSON_GATEWAY_TOPIC',
  redisHost: 'STREAMERSON_REDIS_HOST',
  redisPort: 'STREAMERSON_REDIS_PORT'
});

export const config = {
  ...env,
  port: parseInt(env.port),
  redisPort: parseInt(env.redisPort)
}
