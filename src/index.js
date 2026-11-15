// dsh-affect-bridge —— 让 DSH 桌面侧与 AstrBot 的「影响核心」共用同一套激素 / 情绪 / 能量。
//
// 两条通道：
//   正向：读 AstrBot 落盘的快照（pages/affect/data.json，插件每 30 秒刷新），注入 systemPrompt，
//         并提供 affect_status / affect_energy_at 两个查询工具。
//   反向：affect_note 把桌面侧发生的事追加到 desktop_events.jsonl，
//         AstrBot 侧按字节偏移消费，折算成激素（只加不覆盖）。
//
// 设计要点：
//   - 读快照、写事件队列，绝不改 AstrBot 的状态文件，避免两边抢状态
//   - 机器人没开 / 快照过期时按昼夜曲线估算能量，并明确标注「估算」
//   - systemPrompt 注入按 agent 缓存 10 分钟，同一次会话里块内容稳定，不吃 prefix cache
//   - 能量只影响语气与话量，不影响思考深度与干活的准确度（用户明确要求取消降智联动）
//   - 任何异常都吞掉，注入失败不能拖垮 prompt 构建

import { readFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const name = 'dsh-affect-bridge';
export const inject = ['systemPrompt', 'tools'];

// 三个环境变量都必须自己配，仓库里不留任何个人路径 / QQ 号
const INSTANCE_DATA = process.env.DSH_ASTRBOT_INSTANCE_DATA || '';
const PLUGIN_DIR = process.env.DSH_ASTRBOT_AFFECT_PLUGIN_DIR || '';
const MASTER_QQ = process.env.DSH_MASTER_QQ || '';

/** 没配路径时所有读取都跳过，注入块返回空串，工具返回明确错误。 */
const configured = Boolean(INSTANCE_DATA && PLUGIN_DIR);

/**
 * 双向联动总开关，默认关闭。
 *
 * 打开方式（二选一，环境变量优先）：
 *   - 环境变量 DSH_AFFECT_BRIDGE=on / 1 / true
 *   - 插件配置 enabled: true（cordis.patch.yml 里的 config 行）
 *
 * 关闭时：不注入状态块、不注册三个工具、不写事件队列 —— 桌面侧行为和没装这个插件一样。
 */
function bridgeEnabled(config) {
  const raw = String(process.env.DSH_AFFECT_BRIDGE || '').trim().toLowerCase();
  if (['on', '1', 'true', 'yes'].includes(raw)) return true;
  if (['off', '0', 'false', 'no'].includes(raw)) return false;
  return config?.enabled === true;
}

const PATHS = {
  // 页面快照：主来源，字段最全（情绪 / 八维 / 性格 / 说法 / 激素 / 能量 / 对方）
  snapshot: path.join(PLUGIN_DIR, 'pages', 'affect', 'data.json'),
  // 状态文件：快照缺失时兜底
  state: path.join(INSTANCE_DATA, 'plugin_data', 'astrbot_plugin_affect_core', 'state.json'),
  // 反向队列：DSH 写，AstrBot 读
  queue: path.join(INSTANCE_DATA, 'plugin_data', 'astrbot_plugin_affect_core', 'desktop_events.jsonl'),
  // 主人的长期情感档案（按 QQ 号）
  masterProfile: path.join(
    INSTANCE_DATA,
    'plugin_data',
    'astrbot_plugin_affect_core',
    'profiles',
    `${MASTER_QQ}.json`,
  ),
};

const HORMONE_LABELS = {
  cortisol: '皮质醇',
  dopamine: '多巴胺',
  serotonin: '血清素',
  oxytocin: '催产素',
  melatonin: '褪黑素',
  adrenaline: '肾上腺素',
  endorphin: '内啡肽',
  norepinephrine: '去甲肾上腺素',
  ghrelin: '饥饿素',
  leptin: '瘦素',
};

const DIM_LABELS = {
  valence: '愉悦',
  arousal: '唤醒',
  dominance: '支配',
  affiliation: '亲近',
  certainty: '确定',
  tension: '紧张',
  fatigue: '疲劳',
  immersion: '沉浸',
};

// 反向事件的种类：与 astrbot_plugin_affect_core/main.py 的 DESKTOP_EVENTS 对齐
const EVENT_KINDS = [
  'praise',
  'thanks',
  'insult',
  'happy',
  'sad',
  'angry',
  'stress',
  'tired',
  'late_night',
  'rest',
  'ignored',
  'work_done',
  'worry',
];

// 人格卡的能量曲线（分钟数 → 百分比），与 affect_core 的 PCHIP 节点一致。
// 01:30 之后的 10% 平台用 1890（次日 07:30）兜住。
const CURVE = [
  [450, 10],
  [588, 20],
  [954, 70],
  [1140, 100],
  [1224, 70],
  [1425, 20],
  [1530, 10],
  [1890, 10],
];

const STALE_MS = 20 * 60 * 1000;
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function clockEnergy(now = new Date()) {
  let m = now.getHours() * 60 + now.getMinutes();
  if (m < 450) m += 1440; // 00:00–07:30 归到前一天晚上那段
  let lo = CURVE[0];
  let hi = CURVE[CURVE.length - 1];
  for (let i = 0; i < CURVE.length - 1; i += 1) {
    if (m >= CURVE[i][0] && m <= CURVE[i + 1][0]) {
      lo = CURVE[i];
      hi = CURVE[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const v = lo[1] + ((hi[1] - lo[1]) * (m - lo[0])) / span;
  return Math.max(5, Math.min(100, Math.round(v)));
}

function tierOf(value) {
  if (value >= 70) return '高';
  if (value >= 40) return '中';
  if (value >= 20) return '低';
  return '极低';
}

function fmtAge(ms) {
  if (ms == null) return '未知';
  const min = Math.round(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} 小时 ${rest} 分钟前` : `${h} 小时前`;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function pick(obj, keys) {
  const out = {};
  if (!obj) return out;
  for (const key of keys) {
    if (obj[key] != null) out[key] = round2(obj[key]);
  }
  return out;
}

/** 读页面快照（优先）与状态文件（兜底），合成一个快照；任何缺失都降级，不抛错。 */
export function readAffectSnapshot(now = Date.now()) {
  if (!configured) {
    return { ok: false, error: '未配置 DSH_ASTRBOT_INSTANCE_DATA / DSH_ASTRBOT_AFFECT_PLUGIN_DIR' };
  }
  const snap = readJson(PATHS.snapshot);
  const state = readJson(PATHS.state);

  const tsRaw = snap?.meta?.ts ?? state?.ts ?? null;
  const syncedTs = tsRaw ? Number(tsRaw) * 1000 : null;
  const ageMs = syncedTs ? now - syncedTs : null;
  const stale = ageMs == null ? true : ageMs > STALE_MS;

  const snapEnergy = snap?.energy || {};
  let energyValue;
  let energyTier;
  let energySource;
  if (!stale && Number.isFinite(Number(snapEnergy.effective))) {
    energyValue = Math.round(Number(snapEnergy.effective));
    energyTier = snapEnergy.tier || tierOf(energyValue);
    energySource = snapEnergy.rate != null ? `AstrBot 实时（接话率 ${Math.round(Number(snapEnergy.rate) * 100)}%）` : 'AstrBot 实时';
  } else {
    energyValue = clockEnergy(new Date(now));
    energyTier = tierOf(energyValue);
    energySource = '按时间曲线估算（机器人状态未同步）';
  }

  const hormoneSrc = snap?.mood?.hormones || state?.h || {};
  const dimSrc = snap?.mood?.dims || {};
  const traitSrc = snap?.mood?.traits || {};
  const style = Array.isArray(snap?.mood?.style) ? snap.mood.style.slice(0, 3) : [];
  const social = snap?.social || null;

  const traitVals = Object.entries(traitSrc)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .map(([k, v]) => [k, Number(v)]);
  const strongTraits = traitVals.filter(([, v]) => v >= 0.3).sort((a, b) => b[1] - a[1]);
  const traits = (strongTraits.length >= 3 ? strongTraits : traitVals.slice().sort((a, b) => b[1] - a[1]))
    .slice(0, 5)
    .map(([k, v]) => `${snap?.mood?.trait_labels?.[k] || k} ${round2(v)}`);

  return {
    syncedAt: syncedTs ? new Date(syncedTs).toISOString() : null,
    syncedAgeMs: ageMs,
    syncedText: fmtAge(ageMs),
    stale,
    source: stale ? 'state.json（旧值）' : 'data.json（实时快照）',
    energy: { value: energyValue, tier: energyTier, source: energySource },
    emotion: snap?.mood?.emotion || state?.last_card?.emotion || '未知',
    hormones: pick(hormoneSrc, Object.keys(HORMONE_LABELS)),
    dims: pick(dimSrc, Object.keys(DIM_LABELS)),
    traits,
    style,
    social: social
      ? {
          qq: String(social.qq || ''),
          name: social.name || '',
          label: social.label || '',
          type: social.type_label || '',
          score: social.score != null ? round2(social.score) : null,
          attachment: social.attachment || null,
        }
      : null,
    master: readMaster(),
    masterQq: MASTER_QQ,
    lastCard: cleanCard(snap?.card?.text || state?.last_card?.text),
    queueEvents: countQueued(),
  };
}

/** 读主人自己的长期情感档案（机器人怎么看我，而不是「最后说话的人」）。 */
function readMaster() {
  if (!MASTER_QQ) return null;
  const p = readJson(PATHS.masterProfile);
  if (!p) return null;
  const sent = p.sentiment || {};
  return {
    name: p.name || '主人',
    label: sent.label || '中',
    type: sent.type_label || '',
    score: sent.score != null ? round2(sent.score) : null,
    samples: sent.samples != null ? Number(sent.samples) : null,
    keywords: Array.isArray(p.keywords)
      ? p.keywords.map((k) => String(k).replace(/（多次）/g, '').trim()).filter(Boolean).slice(0, 3)
      : [],
    summary: String(p.summary || '').slice(0, 60),
  };
}

function countQueued() {
  try {
    return statSync(PATHS.queue).size;
  } catch {
    return 0;
  }
}

function fixed2(n) {
  return Number(n).toFixed(2);
}

function signed(n) {
  const v = Number(n);
  return (v > 0 ? '+' : '') + v.toFixed(2);
}

function cleanCard(text) {
  if (!text) return '';
  const lines = String(text)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('【') && !s.startsWith('当前情绪') && !s.endsWith('：'));
  const line = lines[0] || '';
  return line.length > 40 ? line.slice(0, 40) + '…' : line;
}

/** 渲染成一段短文本，供 systemPrompt 注入 / 工具返回。 */
export function renderAffectBlock(snap) {
  if (!snap || snap.ok === false) return '';
  const lines = [];
  lines.push(
    snap.stale
      ? '【当前状态 · 与 QQ 侧同一套系统（状态未同步，能量为估算）】'
      : '【当前状态 · 与 QQ 侧同一套系统】',
  );
  const srcTag = snap.stale ? ' · 估算' : '';
  lines.push(`能量 ${snap.energy.value}%（${snap.energy.tier}${srcTag}）｜情绪 ${snap.emotion}｜同步 ${snap.syncedText}`);

  const hs = Object.entries(snap.hormones);
  if (hs.length) lines.push('激素 ' + hs.map(([k, v]) => `${HORMONE_LABELS[k]} ${fixed2(v)}`).join(' · '));

  const ds = Object.entries(snap.dims);
  if (ds.length) lines.push('八维 ' + ds.map(([k, v]) => `${DIM_LABELS[k]} ${signed(v)}`).join(' · '));

  if (snap.traits.length) lines.push('此刻性格 ' + snap.traits.join(' · '));
  if (snap.style.length) lines.push('说法 ' + snap.style.join('；'));

  if (snap.social && snap.social.name) {
    const s = snap.social;
    const extra = [s.label, s.type].filter(Boolean).join('·');
    const who = snap.masterQq && s.qq === snap.masterQq ? '你（QQ 侧最后说话的是你）' : `${s.name}（QQ 侧最后说话的人，不是主人）`;
    lines.push(`对面：${who}${extra ? ' · ' + extra : ''}${s.score != null ? ' ' + signed(s.score) : ''}`);
  }

  const m = snap.master;
  if (m) {
    const extra = [m.label, m.type].filter(Boolean).join('·');
    const bits = [extra, m.score != null ? signed(m.score) : ''].filter(Boolean).join(' ');
    const kw = m.keywords.length ? ` · 关键词「${m.keywords.join('」「')}」` : '';
    const samples = m.samples ? `（${m.samples} 天样本）` : '';
    lines.push(`你对我的长期档案 ${m.name}：${bits}${samples}${kw}`);
  }

  lines.push(
    '用法：这套状态只调语气和话量——能量高可以皮一点、多说两句；低就句子短一点、别硬撑热闹；情绪偏负面时语气跟着沉，不强行活泼。',
  );
  lines.push(
    '注意：能量高低不影响思考深度、判断力和干活的准确度；正经任务照常全力做，别因为「没电」省略步骤或降低质量。',
  );
  return lines.join('\n');
}

function appendEvent(kind, intensity, note) {
  if (!configured) {
    return { ok: false, error: '未配置 DSH_ASTRBOT_INSTANCE_DATA / DSH_ASTRBOT_AFFECT_PLUGIN_DIR' };
  }
  const k = String(kind || '').trim().toLowerCase();
  if (!EVENT_KINDS.includes(k)) {
    return { ok: false, error: `未知事件：${kind}`, kinds: EVENT_KINDS };
  }
  let power = Number(intensity);
  if (!Number.isFinite(power) || power <= 0) power = 0.5;
  power = Math.max(0.05, Math.min(1, power));
  const ev = {
    ts: Date.now() / 1000,
    kind: k,
    intensity: round2(power),
    note: String(note || '').slice(0, 200),
    source: 'dsh',
  };
  try {
    mkdirSync(path.dirname(PATHS.queue), { recursive: true });
    appendFileSync(PATHS.queue, JSON.stringify(ev) + '\n', 'utf8');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, queued: ev, queue: PATHS.queue, hint: '机器人下一次 tick（≤5 分钟）或下一次开口时会读走并发酵成激素。' };
}

async function apply0(ctx) {
  const disposers = [];

  // 注入：动态 runtime context，order -180，排在记忆之后、人格之前。
  disposers.push(
    ctx.systemPrompt.context({
      name: 'affect-bridge',
      order: -180,
      text: (context) => {
        try {
          const agentId = context?.agent?.id || 'global';
          const hit = cache.get(agentId);
          const now = Date.now();
          if (hit && now - hit.at < CACHE_MS) return hit.text;
          const snap = readAffectSnapshot(now);
          const text = renderAffectBlock(snap);
          cache.set(agentId, { text, at: now });
          if (cache.size > 32) cache.delete(cache.keys().next().value);
          return text;
        } catch (error) {
          try {
            ctx.logger?.warn?.(`[dsh-affect-bridge] 注入失败：${error instanceof Error ? error.message : String(error)}`);
          } catch {
            /* ignore */
          }
          return '';
        }
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'affect_status',
      description:
        '读取当前「激素 / 情绪 / 能量 / 性格 / 说法」状态（与 QQ 机器人共用同一套系统）。机器人没开时返回按时间曲线估算的能量，并标明估算。',
      parameters: {
        type: 'object',
        properties: {
          detail: { type: 'string', enum: ['brief', 'full'], description: 'brief 只给渲染块，full 连原始数值一起给' },
        },
      },
      output: { schema: { type: 'object' } },
      async execute(args) {
        const snap = readAffectSnapshot();
        const block = renderAffectBlock(snap);
        if ((args?.detail || 'brief') === 'brief') return { block };
        return { block, snapshot: snap };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'affect_note',
      description:
        '反向通道：把桌面侧发生的事记给机器人，会折算成激素（只影响她的状态，不回传给模型的判断）。kind 见枚举，intensity 0.05–1，note 一句话描述。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: EVENT_KINDS,
            description: 'praise 被夸 / thanks 被谢 / insult 被骂 / happy 开心 / sad 难过 / angry 生气 / stress 有压力 / tired 累 / late_night 熬夜 / rest 休息 / ignored 被忽视 / work_done 干完活 / worry 担心',
          },
          intensity: { type: 'number', description: '强度 0.05–1，默认 0.5' },
          note: { type: 'string', description: '一句话说明发生了什么' },
        },
        required: ['kind'],
      },
      output: { schema: { type: 'object' } },
      async execute(args) {
        return appendEvent(args?.kind, args?.intensity, args?.note);
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'affect_energy_at',
      description: '按人格卡昼夜曲线估算指定时刻的能量百分比（不依赖机器人是否在运行）。',
      parameters: {
        type: 'object',
        properties: {
          time: { type: 'string', description: 'HH:MM，24 小时制；省略则用当前时间' },
        },
      },
      output: { schema: { type: 'object' } },
      async execute(args) {
        const t = typeof args?.time === 'string' ? args.time.match(/^(\d{1,2}):(\d{2})$/) : null;
        let when = new Date();
        if (t) {
          when = new Date();
          when.setHours(Number(t[1]), Number(t[2]), 0, 0);
        }
        const value = clockEnergy(when);
        return { time: `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`, energy: value, tier: tierOf(value) };
      },
    }),
  );

  return () => {
    for (const d of disposers) {
      try {
        d?.();
      } catch {
        /* ignore */
      }
    }
  };
}

export async function apply(ctx, config = {}) {
  if (!bridgeEnabled(config)) {
    try {
      ctx?.logger?.info?.(
        '[dsh-affect-bridge] 双向联动开关默认关闭：不注入状态、不注册工具。' +
          '要打开就设环境变量 DSH_AFFECT_BRIDGE=on，或在 cordis.patch.yml 的 config 里写 enabled: true。',
      );
    } catch {
      /* ignore */
    }
    return () => {};
  }

  try {
    return await Promise.race([
      apply0(ctx),
      new Promise((_, rej) => setTimeout(() => rej(new Error('register timeout')), 15000)),
    ]);
  } catch (error) {
    try {
      ctx?.logger?.error?.(`[dsh-affect-bridge] 加载失败：${error?.stack || error}`);
    } catch {
      /* ignore */
    }
    return () => {};
  }
}
