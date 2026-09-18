// 天气模块单元测试：纯逻辑 + 用注入的 fetch 假件验证网络路径与失败路径。
// 运行：node tests/weather.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describe, buildUrl, parseForecast, fetchWeather,
  staleHours, missingDates, ageText, summaryLine, weatherAlerts, STALE_HOURS,
} from '../app/weather.js';

const PLACES = [
  { date: '2026-09-19', name: '齐齐哈尔', lat: 47.3392, lon: 123.9615 },
  { date: '2026-09-20', name: '海拉尔', lat: 49.2114, lon: 119.7558 },
];

const canned = (over = {}) => ({
  daily: {
    time: ['2026-09-18', '2026-09-19', '2026-09-20'],
    weather_code: [0, 61, 75],
    temperature_2m_max: [20, 12.5, -3],
    temperature_2m_min: [5, 1.4, -11],
    precipitation_probability_max: [0, 70, 30],
    wind_speed_10m_max: [10, 45, 8],
    sunrise: ['2026-09-18T05:30', '2026-09-19T05:31', '2026-09-20T05:32'],
    sunset: ['2026-09-18T18:00', '2026-09-19T17:58', '2026-09-20T17:56'],
    ...over,
  },
});

test('天气代码翻译成中文与图标', () => {
  assert.deepEqual(describe(0), { label: '晴', icon: '☀️' });
  assert.equal(describe(61).label, '小雨');
  assert.equal(describe(75).icon, '❄️');
  assert.equal(describe(9999).label, '未知天气', '未知代码不能崩，要给可读的兜底');
  assert.equal(describe(null).label, '未知天气');
});

test('请求地址：批量查询所有地点，时区固定为中国时区', () => {
  const url = buildUrl(PLACES);
  assert.ok(url.startsWith('https://api.open-meteo.com/v1/forecast?'));
  assert.ok(url.includes('latitude=47.3392%2C49.2114'), '经纬度要按逗号批量传');
  assert.ok(url.includes('longitude=123.9615%2C119.7558'));
  assert.ok(url.includes('timezone=Asia%2FShanghai'), '时区必须固定，否则日期会错一天');
  assert.ok(url.includes('forecast_days=16'));
});

test('解析：按日期摊平，并带上对应地点名', () => {
  const byDate = parseForecast([canned(), canned()], PLACES);
  assert.equal(byDate['2026-09-19'].place, '齐齐哈尔');
  assert.equal(byDate['2026-09-19'].label, '小雨');
  assert.equal(byDate['2026-09-19'].tmin, 1.4);
  assert.equal(byDate['2026-09-20'].label, '大雪');
  assert.equal(byDate['2026-09-18'].precip, 0);
});

test('解析：每一天必须认领自己那个地点，不能被最后一个地点覆盖（回归测试）', () => {
  // API 对每个地点都返回全部 16 天，同一天会出现多次。
  // 早期写法是"后写覆盖"，结果 9 天全部显示最后一个地点（哈尔滨）的天气。
  const byDate = parseForecast([canned(), canned(), canned()], PLACES);
  assert.equal(byDate['2026-09-19'].place, '齐齐哈尔', '9.19 应取齐齐哈尔');
  assert.equal(byDate['2026-09-20'].place, '海拉尔', '9.20 应取海拉尔');
  assert.equal(byDate['2026-09-19'].primary, true);
  assert.equal(byDate['2026-09-20'].primary, true);
  // 不在行程内的日期用先到的地点兜底，并标为非专属
  assert.equal(byDate['2026-09-18'].primary, false);
  assert.equal(byDate['2026-09-18'].place, '齐齐哈尔');
});

test('解析：单个对象（一个地点）也要能处理', () => {
  const byDate = parseForecast(canned(), [PLACES[0]]);
  assert.equal(Object.keys(byDate).length, 3);
  assert.equal(byDate['2026-09-19'].place, '齐齐哈尔');
});

test('解析：字段缺失或结构异常时退化为 null，不抛错', () => {
  const byDate = parseForecast([{ daily: { time: ['2026-09-19'] } }], PLACES);
  assert.equal(byDate['2026-09-19'].tmax, null);
  assert.equal(byDate['2026-09-19'].precip, null);
  assert.equal(byDate['2026-09-19'].label, '未知天气');
  assert.deepEqual(parseForecast(null, PLACES), {});
  assert.deepEqual(parseForecast([{}], PLACES), {});
});

test('摘要行：温度/降水/风，缺项要跳过而不是显示 null', () => {
  const byDate = parseForecast([canned()], PLACES);
  assert.equal(summaryLine(byDate['2026-09-19']), '1°~13° · 降水 70% · 风 45 km/h');
  assert.equal(summaryLine(byDate['2026-09-20']), '-11°~-3° · 降水 30% · 风 8 km/h');
  assert.equal(summaryLine({ tmin: 3, tmax: 9 }), '3°~9°');
  assert.equal(summaryLine(null), '');
});

test('提醒：降水/大风/低温分别触发，阈值边界正确', () => {
  assert.deepEqual(weatherAlerts({ precip: 70, wind: 45, tmin: 1.5, tmax: 12 }),
    ['降水概率高，林区砂石路容易打滑，放慢速度', '风大，草原和垭口注意侧风', '夜里很冷，外套带够']);
  assert.deepEqual(weatherAlerts({ precip: 30 }), ['可能下雨，带件防水的'], '30% 起提示可能下雨');
  assert.deepEqual(weatherAlerts({ precip: 29 }), [], '29% 不提示');
  assert.deepEqual(weatherAlerts({ tmin: 0 }), ['夜间零下，注意保暖与路面结冰']);
  assert.deepEqual(weatherAlerts({ tmax: 28 }), ['白天热，防晒和水要跟上']);
  assert.deepEqual(weatherAlerts(null), []);
});

test('新鲜度与缺失日期', () => {
  const now = Date.now();
  assert.equal(staleHours(0, now), Infinity, '没有抓取时间视为无限旧');
  assert.ok(Math.abs(staleHours(now - 3600000, now) - 1) < 0.01);
  assert.ok(!(staleHours(now) >= STALE_HOURS), '刚抓的应算新鲜');
  assert.ok(staleHours(now - 7 * 3600000, now) >= STALE_HOURS, '7 小时前算过时');
  assert.deepEqual(missingDates({ '2026-09-19': {} }, ['2026-09-19', '2026-09-20']), ['2026-09-20']);
  assert.deepEqual(missingDates({}, []), []);
  assert.deepEqual(missingDates(undefined, ['2026-09-19']), ['2026-09-19'], '缓存为空也不能崩');
});

test('数据时间文案', () => {
  const now = Date.now();
  assert.equal(ageText(0, now), '还没有天气数据');
  assert.equal(ageText(now - 60000, now), '刚刚更新');
  assert.equal(ageText(now - 5 * 3600000, now), '5 小时前更新');
  assert.equal(ageText(now - 50 * 3600000, now), '2 天前更新');
});

test('网络路径：成功时按日期返回，且只发一次请求', async () => {
  let calls = 0;
  const fakeFetch = async (url) => {
    calls += 1;
    assert.ok(String(url).includes('api.open-meteo.com'));
    return { ok: true, status: 200, json: async () => [canned(), { daily: { ...canned().daily, weather_code: [0, 0, 75] } }] };
  };
  const { byDate } = await fetchWeather(PLACES, fakeFetch);
  assert.equal(calls, 1, '9 个地点要合并成一次请求，不能逐个发');
  assert.equal(byDate['2026-09-19'].place, '齐齐哈尔');
  assert.equal(byDate['2026-09-19'].label, '小雨');
  assert.equal(byDate['2026-09-20'].label, '大雪', '9.20 要取第二个地点自己的数据');
});

test('失败路径：HTTP 错误要抛出可读信息（由调用方保留旧数据）', async () => {
  await assert.rejects(() => fetchWeather(PLACES, async () => ({ ok: false, status: 500 })), /天气服务返回 500/);
  await assert.rejects(() => fetchWeather(PLACES, async () => { throw new Error('网络断了'); }), /网络断了/);
  assert.deepEqual(await fetchWeather([], async () => { throw new Error('不该被调用'); }), { byDate: {} }, '没有坐标时不应发请求');
});
