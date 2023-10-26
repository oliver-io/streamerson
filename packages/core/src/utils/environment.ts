const StreamersonEnvironmentDefaultValues = {
  STREAMERSON_REDIS_HOST: 'localhost',
  STREAMERSON_REDIS_PORT: '6379',
  STREAMERSON_GATEWAY_TOPIC: 'default',
  STREAMERSON_GATEWAY_PORT: '42000',
  STREAMERSON_GATEWAY_HOST: 'localhost'
}

type StreamersonEnvironmentKey = keyof typeof StreamersonEnvironmentDefaultValues;

export function environmentValueFor<T extends StreamersonEnvironmentKey>(
  key: StreamersonEnvironmentKey
): string {
  return typeof process.env[key] === 'string' ? (process.env[key] || StreamersonEnvironmentDefaultValues[key]) : StreamersonEnvironmentDefaultValues[key];
}
