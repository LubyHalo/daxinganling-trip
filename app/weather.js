// 天气：Open-Meteo（免费、无需注册 key、响应头带 Access-Control-Allow-Origin: *）。
//
// 重要前提：这个应用的核心是"断网可用"，天气是唯一需要联网的功能，所以它必须：
//   1. 只在有网时抓，抓到的结果存本地；
//   2. 断网时显示上次的数据并标明时间，绝不因为拿不到天气而影响其它功能；
//   3. 任何异常都自己吞掉，不往上抛给渲染链路。
//
// 本模块不依赖 DOM，可以在 Node 里直接单元测试。

export const API = 'https://api.open-meteo.com/v1/forecast';
export const STALE_HOURS = 6; // 超过这个时长，联网时自动刷新

/** WMO 天气代码 → 中文描述 + 图标 */
const WMO = {
  0: ['晴', '☀️'],
  1: ['晴间多云', '🌤️'],
  2: ['多云', '⛅'],
  3: ['阴', '☁️'],
  45: ['有雾', '🌫️'],
  48: ['雾凇', '🌫️'],
  51: ['小毛毛雨', '🌦️'],
  53: ['毛毛雨', '🌦️'],
  55: ['密毛毛雨', '🌧️'],
  56: ['冻毛毛雨', '🌧️'],
  57: ['强冻毛毛雨', '🌧️'],
  61: ['小雨', '🌧️'],
  63: ['中雨', '🌧️'],
  65: ['大雨', '🌧️'],
  66: ['小冻雨', '🌧️'],
  67: ['强冻雨', '🌧️'],
  71: ['小雪', '🌨️'],
  73: ['中雪', '🌨️'],
  75: ['大雪', '❄️'],
  77: ['米雪', '🌨️'],
  80: ['小阵雨', '🌦️'],
  81: ['中阵雨', '🌧️'],
  82: ['强阵雨', '⛈️'],
  85: ['小阵雪', '🌨️'],
  86: ['大阵雪', '❄️'],
  95: ['雷阵雨', '⛈️'],
  96: ['雷阵雨伴冰雹', '⛈️'],
  99: ['雷阵雨伴大冰雹', '⛈️'],
};

export function describe(code) {
  const hit = WMO[code];
  return hit ? { label: hit[0], icon: hit[1] } : { label: '未知天气', icon: '•' };
}

/** 一次请求拿回所有地点：Open-Meteo 支持经纬度逗号分隔的批量查询 */
export function buildUrl(places) {
  const params = new URLSearchParams({
    latitude: places.map((p) => p.lat).join(','),
    longitude: places.map((p) => p.lon).join(','),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset',
    timezone: 'Asia/Shanghai',
    forecast_days: '16',
  });
  return `${API}?${params.toString()}`;
}

/**
 * 把 API 返回（数组或单对象）摊平成 日期 → 天气 的映射。
 *
 * 注意：API 对**每个**地点都返回全部 16 天，也就是同一个日期会出现多次。
 * 所以不能"后写覆盖"——必须让每一天认领属于它自己的那个地点（places[].date）。
 * 不在行程内的日期（比如出发前看今天）用先到的那个地点兜底，并标 primary:false。
 */
export function parseForecast(json, places = []) {
  const list = Array.isArray(json) ? json : [json];
  const byDate = {};
  list.forEach((entry, i) => {
    const place = places[i] || {};
    const daily = entry && entry.daily;
    if (!daily || !Array.isArray(daily.time)) return;
    daily.time.forEach((date, k) => {
      const primary = Boolean(place.date) && place.date === date;
      const prev = byDate[date];
      // 已经认领过这一天就不许被别人改写；非专属数据先到先得
      if (prev && (prev.primary || !primary)) return;
      const desc = describe(daily.weather_code ? daily.weather_code[k] : null);
      const pick = (key) => (Array.isArray(daily[key]) ? daily[key][k] : null);
      byDate[date] = {
        primary,
        place: place.name || null,
        label: desc.label,
        icon: desc.icon,
        code: pick('weather_code'),
        tmax: pick('temperature_2m_max'),
        tmin: pick('temperature_2m_min'),
        precip: pick('precipitation_probability_max'),
        wind: pick('wind_speed_10m_max'),
        sunrise: pick('sunrise'),
        sunset: pick('sunset'),
      };
    });
  });
  return byDate;
}

export async function fetchWeather(places, fetchImpl = fetch) {
  if (!places || !places.length) return { byDate: {} };
  const res = await fetchImpl(buildUrl(places));
  if (!res || !res.ok) throw new Error(`天气服务返回 ${res ? res.status : '无响应'}`);
  const json = await res.json();
  return { byDate: parseForecast(json, places) };
}

export function staleHours(fetchedAt, now = Date.now()) {
  if (!fetchedAt) return Infinity;
  return (now - fetchedAt) / 3600000;
}

export function missingDates(byDate, dates) {
  return (dates || []).filter((d) => !byDate || !byDate[d]);
}

export function ageText(fetchedAt, now = Date.now()) {
  if (!fetchedAt) return '还没有天气数据';
  const h = staleHours(fetchedAt, now);
  if (h < 1) return '刚刚更新';
  if (h < 24) return `${Math.floor(h)} 小时前更新`;
  return `${Math.floor(h / 24)} 天前更新`;
}

/** 一行摘要，用在逐日行程里 */
export function summaryLine(w) {
  if (!w) return '';
  const parts = [];
  if (w.tmin != null && w.tmax != null) parts.push(`${Math.round(w.tmin)}°~${Math.round(w.tmax)}°`);
  if (w.precip != null) parts.push(`降水 ${Math.round(w.precip)}%`);
  if (w.wind != null) parts.push(`风 ${Math.round(w.wind)} km/h`);
  return parts.join(' · ');
}

/**
 * 由天气数据推导的出行提醒。这些是简单的阈值判断，不是气象预报结论，
 * 只用来把"值得注意的"顶到眼前。
 */
export function weatherAlerts(w) {
  const out = [];
  if (!w) return out;
  if (w.precip != null && w.precip >= 60) out.push('降水概率高，林区砂石路容易打滑，放慢速度');
  else if (w.precip != null && w.precip >= 30) out.push('可能下雨，带件防水的');
  if (w.wind != null && w.wind >= 40) out.push('风大，草原和垭口注意侧风');
  if (w.tmin != null && w.tmin <= 0) out.push('夜间零下，注意保暖与路面结冰');
  else if (w.tmin != null && w.tmin <= 5) out.push('夜里很冷，外套带够');
  if (w.tmax != null && w.tmax >= 28) out.push('白天热，防晒和水要跟上');
  return out;
}
