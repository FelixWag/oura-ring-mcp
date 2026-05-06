export const ENDPOINTS = {
  dailySleep: '/usercollection/daily_sleep',
  dailyReadiness: '/usercollection/daily_readiness',
  dailyActivity: '/usercollection/daily_activity',
  sleep: '/usercollection/sleep',
  heartrate: '/usercollection/heartrate',
  workout: '/usercollection/workout',
  session: '/usercollection/session',
  spo2: '/usercollection/daily_spo2',
  personalInfo: '/usercollection/personal_info',
} as const;

export type EndpointPath = (typeof ENDPOINTS)[keyof typeof ENDPOINTS];
