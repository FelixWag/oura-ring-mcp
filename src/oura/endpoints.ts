export const ENDPOINTS = {
  dailySleep: '/usercollection/daily_sleep',
  dailyReadiness: '/usercollection/daily_readiness',
  dailyActivity: '/usercollection/daily_activity',
  dailyStress: '/usercollection/daily_stress',
  dailyResilience: '/usercollection/daily_resilience',
  dailyCardiovascularAge: '/usercollection/daily_cardiovascular_age',
  vo2Max: '/usercollection/vO2_max', // Oura's path uses literal mixed-case "vO2"; preserved as-is.
  sleepTime: '/usercollection/sleep_time',
  sleep: '/usercollection/sleep',
  heartrate: '/usercollection/heartrate',
  workout: '/usercollection/workout',
  session: '/usercollection/session',
  restModePeriod: '/usercollection/rest_mode_period',
  spo2: '/usercollection/daily_spo2',
  personalInfo: '/usercollection/personal_info',
  enhancedTag: '/usercollection/enhanced_tag',
} as const;

export type EndpointPath = (typeof ENDPOINTS)[keyof typeof ENDPOINTS];
