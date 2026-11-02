/**
 * The drafting of one annotation.
 *
 * This is the same drafting the Markdown preview plugin does, moved here so
 * that the guest of a shared conversation may use it too: the guest picks a
 * passage, writes what has to change, and the Host asks the model for the
 * wording of the annotation.
 *
 * The Host owns the model; this module only speaks to it.
 */
/**
 * Host half of the annotation draft channel.
 *
 * The reviewer annotates a prototype in the preview and writes what has to
 * change. Writing that sentence well is the slow part, so the page asks the
 * Host for one draft of it. The Host owns the model: this module picks the
 * default model, asks it for exactly one annotation line, and hands the page
 * back the text.
 *
 * The Host's `llm` service is the only path into a model. This module never
 * talks to a provider itself, and it never renders anything.
 *
 * Every dependency is injectable, so the behaviour can be tested without a
 * model: `llm`, `agentDefaultModel` and `timeoutMs`.
 */

/** Wall-clock budget for one request. */
const DEFAULT_TIMEOUT_MS = 30000;

/** Sampling temperature: the answer is an instruction, not prose. */
const TEMPERATURE = 0.3;

/** Raised when the Host has no model to answer with. */
const NO_MODEL_MESSAGE = '宿主未配置可用模型，AI 辅助不可用';

/**
 * What the reviewer wants the annotation to be about.
 *
 * The id is the contract with the client; the text is what the model is told
 * to focus on.
 */
const INTENTS = new Map([
  ['copy', '文案表达：把话说清楚、说人话，给出改后的具体文案'],
  ['ux', '交互体验：点击后的反馈、状态变化、空态与异常态'],
  ['issue', '问题风险：指出信息层级、状态语义与业务规则上的缺陷'],
  ['rule', '业务规则：补齐边界条件、权限、限额与状态机'],
  ['translate', '本地化：翻译成英文并保持术语与界面语气一致'],
]);

/**
 * The system prompt of the channel.
 *
 * The answer goes straight into the annotation box, so it has to be an
 * instruction the agent can execute, not a reviewer's essay. The answer
 * arrives as one JSON object: a stream that is cut in the middle leaves the
 * JSON broken, and a broken answer is an answer the reviewer must not see.
 */
const SYSTEM_PROMPT = [
  '你是一名资深 B 端产品经理兼交互评审专家，正在评审一份交互原型或设计稿的局部。',
  '你会看到：一个文件、一个被指到的元素（或图片区域）、评审人自己写的初步批注，以及他想要的评审角度。',
  '请写出**一条**可以直接交给研发执行的批注要求：',
  '- 必须落到可执行的动作（改成什么、补什么、去掉什么），不要停在"建议优化"这类空话；',
  '- 不要编造原型里没有的字段、规则或数值；',
  '- 评审人已经写明的要求必须保留，并在此基础上写得更具体；',
  '- 正文不超过 120 字，必须是一句完整的话，不要写一半。',
  '只输出一个 JSON 对象：不要使用 Markdown 代码块，不要输出解释、前言或结尾语。',
  'JSON 字段说明：',
  '  text: 批注正文，一句话，直接给出要做的修改',
  '所有字段都必须出现。',
].join('\n');

/**
 * Read a string field and trim it.
 * @param {any} value - any value.
 * @returns {string} the trimmed string, or '' when the value is not a string.
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Build an error with a Chinese, user-facing message.
 * @param {string} message - the Chinese message.
 * @param {any} [cause] - the underlying failure, kept for diagnosis only.
 * @returns {Error} the error to throw.
 */
function aiError(message, cause) {
  const error = new Error(message);
  error.code = 'mmd-annotate/failed';
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * Read one Host service without assuming it is mounted.
 * @param {any} ctx - the Host plugin context.
 * @param {string} name - the service name.
 * @returns {any} the service, or undefined.
 */
export function serviceOf(ctx, name) {
  try {
    if (ctx !== null && ctx !== undefined && typeof ctx.get === 'function') {
      const found = ctx.get(name);
      if (found !== undefined && found !== null) return found;
    }
  } catch {
    // The context does not expose services this way; try the property below.
  }
  try {
    if (ctx !== null && ctx !== undefined) {
      const found = ctx[name];
      if (found !== undefined && found !== null) return found;
    }
  } catch {
    // The service is not reachable from this context.
  }
  return undefined;
}

/**
 * Ask the model for one completion and return its text.
 *
 * The call is prepared first, because a prepared call binds one adapter
 * generation to one dispatch: `stream` refuses options whose provider, model,
 * reasoning effort, temperature or token cap differ from the prepared config.
 * The stream options are therefore built from `prepared.config`.
 * @param {object} options - the call parameters.
 * @returns {Promise<string>} the model's answer.
 */
async function complete({ llm, provider, model, system, user, maxTokens, signal, selection, selectedEffort }) {
  // A model that thinks must be allowed to think: the effort is chosen from
  // what the model says it can do, because the default of the Host is "no
  // thinking", and a model that requires thinking refuses the call.
  const prepared = await llm.prepareCall(
    { provider, model, temperature: TEMPERATURE, maxTokens, ...(selectedEffort !== undefined ? { reasoningEffort: selectedEffort } : {}) },
    signal,
    (controls, info) => {
      if (controls.reasoningEffort !== undefined) return controls;
      const reasoning = info?.reasoning;
      if (process.env.DSH_SHARE_ANNOTATE_DEBUG === '1') {
        console.log('[share-annotate] model info', JSON.stringify(info).slice(0, 600));
      }
      if (reasoning === undefined || reasoning === null) return controls;
      const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
      const chosen = reasoning.defaultEffort ?? efforts.find((effort) => effort?.id !== 'none')?.id;
      if (chosen === undefined) return controls;
      return { ...controls, reasoningEffort: chosen };
    },
  );
  const config = prepared?.config ?? { provider, model, temperature: TEMPERATURE, maxTokens };
  const request = {
    ...config,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    system,
    signal,
  };
  const stream = prepared.stream(request);
  let answer = '';
  let failure;
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      answer += chunk.text;
      continue;
    }
    if (chunk.type === 'finish') {
      const reason = chunk.reason;
      if (reason !== null && typeof reason === 'object' && (reason.kind === 'error' || reason.kind === 'aborted')) {
        failure = reason;
      }
    }
  }
  if (failure !== undefined) {
    // The reason of the model is told: "try again" on its own helps nobody.
    const detail = '：' + JSON.stringify(failure).slice(0, 200) + ' | selection: ' + JSON.stringify(selection).slice(0, 300)
    throw aiError('AI 生成失败，请重试' + detail);
  }
  return answer.trim();
}

/**
 * Build the user prompt from the annotation context.
 * @param {object} request - the checked context.
 * @returns {string} the user prompt.
 */
function userPrompt(request) {
  const lines = [`文件：${request.path}`];
  if (request.kind === 'element') {
    lines.push(`对象：HTML 元素 <${request.tag}>，选择器 ${request.selector}`);
  } else {
    lines.push(`对象：图片区域 ${request.area}`);
  }
  if (request.subject !== '') lines.push(`对象内容：${request.subject}`);
  if (request.comment !== '') lines.push(`评审人已写：${request.comment}`);
  lines.push(`评审角度：${request.intentText}`);
  if (request.note !== '') lines.push(`补充要求：${request.note}`);
  return lines.join('\n');
}

/**
 * Read the drafted annotation out of the model's answer.
 *
 * The answer is one JSON object, but a model that ignores the instruction
 * still answers with prose. The braces are therefore taken from the first
 * one to the last one, and a failure means the answer is not usable.
 * @param {string} raw - the model's answer.
 * @returns {string} the drafted annotation.
 */
function parseDraft(raw) {
  const body = raw.trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return '';
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return text(parsed?.text);
  } catch {
    return '';
  }
}

/**
 * Draft one annotation.
 *
 * @param {any} payload - the client payload.
 * @param {object} [deps] - the injected dependencies.
 * @param {any} [deps.llm] - the Host's `llm` service.
 * @param {any} [deps.agentDefaultModel] - the Host's `agentDefaultModel` service.
 * @param {number} [deps.timeoutMs] - the wall-clock budget of the request.
 * @returns {Promise<{ text: string }>} the drafted annotation.
 * @throws {Error} with a Chinese message when the request cannot be served.
 */
export async function draftAnnotation(payload, deps = {}) {
  const llm = deps.llm;
  const agentDefaultModel = deps.agentDefaultModel;
  if (llm === undefined || llm === null || typeof llm.prepareCall !== 'function') {
    throw aiError(NO_MODEL_MESSAGE);
  }
  if (agentDefaultModel === undefined || agentDefaultModel === null || typeof agentDefaultModel.currentSelection !== 'function') {
    throw aiError(NO_MODEL_MESSAGE);
  }

  const selection = agentDefaultModel.currentSelection();
  const provider = text(selection?.provider);
  const model = text(selection?.model);
  if (provider === '' || model === '') throw aiError(NO_MODEL_MESSAGE);
  // The selection of the Host may carry the effort the model needs.
  const selectedEffort = selection?.reasoningEffort
    ?? selection?.reasoning?.effort
    ?? selection?.reasoning?.id
    ?? selection?.effort

  const intent = text(payload?.intent);
  const intentText = INTENTS.get(intent) ?? INTENTS.get('issue');
  const request = {
    path: text(payload?.path) || '(未知文件)',
    kind: payload?.kind === 'region' ? 'region' : 'element',
    tag: text(payload?.tag) || 'div',
    selector: text(payload?.selector) || '(未知选择器)',
    area: text(payload?.area) || '(未知区域)',
    subject: text(payload?.subject).slice(0, 600),
    comment: text(payload?.comment).slice(0, 600),
    note: text(payload?.note).slice(0, 600),
    intentText,
  };

  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const user = userPrompt(request);
    // A stream that is cut in the middle leaves an answer the reviewer must
    // not see, so an unusable answer is asked for once more.
    let answer = '';
    for (let attempt = 0; attempt < 2 && answer === ''; attempt += 1) {
      const raw = await complete({
        llm,
        provider,
        model,
        selection,
        selectedEffort,
        system: SYSTEM_PROMPT,
        user,
        maxTokens: 400,
        signal: controller.signal,
      });
      answer = parseDraft(raw);
    }
    if (answer === '') throw aiError('AI 没有返回可用内容，请重试');
    return { text: answer };
  } catch (error) {
    if (timedOut) throw aiError('AI 生成超时，请稍后再试', error);
    if (error?.name === 'AbortError') throw aiError('AI 请求已取消', error);
    if (typeof error?.message === 'string' && error.message !== '') throw error;
    throw aiError('AI 生成失败，请重试', error);
  } finally {
    clearTimeout(timer);
  }
}
