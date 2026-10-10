/** Константы входа. Значения из AUTH.md, менять только вместе с документом. */
export const AUTH = {
  /** Неверных PIN подряд на устройстве до блокировки PIN */
  pinFailLimit: 5,
  /** Неверных паролей подряд на логине до блокировки входа */
  loginFailLimit: 5,
  /** Длительность блокировки входа по шагам: 15 минут, 1 час, 24 часа. Дальше остаётся 24 часа */
  loginLockMinutes: [15, 60, 24 * 60] as const,
  /** Лимиты по IP за окно */
  ipLoginFailLimit: 20,
  ipPinFailLimit: 30,
  ipWindowMinutes: 15,
  /** Сессия живёт 12 часов с момента последнего ввода PIN */
  sessionHours: 12,
  /** Cookie устройства живёт 180 дней и продлевается при использовании */
  deviceDays: 180,
  /** После входа по паролю PIN нужно задать в течение этого окна */
  pinSetupWindowMinutes: 10,
  /** Как часто обновляем last_activity, чтобы не писать в базу на каждый запрос */
  activityTouchSeconds: 15,
  /** Как часто продлеваем cookie устройства */
  deviceTouchHours: 12,
  maxLoginLength: 64,
  maxPasswordLength: 256,
  forbiddenPins: ['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321'],
} as const;

export const COOKIE_DEVICE = 'pva_device';
export const COOKIE_SESSION = 'pva_session';
export const HEADER_CSRF = 'x-csrf-token';

export const MSG = {
  invalidCredentials: 'Неверный логин или пароль',
  throttled: 'Слишком много попыток. Повторите позже',
  weakPin: 'Выберите менее очевидный PIN',
  pinBlocked: 'PIN заблокирован. Войдите по паролю',
} as const;
