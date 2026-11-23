/**
 * model-fallback: 按配置的顺序表，在模型线路不可用时自动换线重发同一次请求。
 * @module dsh-model-fallback
 */

/** Cordis 插件名，用于 Loader 诊断信息。 */
const name = "model-fallback";
/** 需要 llm 服务来重发请求。 */
const inject = ["llm"];

/** 默认认定为「这条线路坏了」的错误码。 */
const DEFAULT_ON = [
	"UNKNOWN_MODEL",
	"INVALID_REQUEST",
	"MISSING_CREDENTIAL",
	"INVALID_CREDENTIAL",
	"QUOTA_EXCEEDED",
	"MALFORMED_RESPONSE",
	"EMPTY_RESPONSE",
	"NO_ADAPTER",
	"UNSUPPORTED_REASONING_EFFORT",
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"LLM_STREAM_IDLE_TIMEOUT",
	"TRANSPORT",
];

/** 默认冷却时间：三十分钟。 */
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

function routeKey(provider, model) {
	return `${provider}\u0000${model}`;
}

function routeName(route) {
	return route.label ?? `${route.provider} / ${route.model}`;
}

function readChain(value) {
	if (!Array.isArray(value)) return [];
	const chain = [];
	for (const entry of value) {
		if (entry === null || typeof entry !== "object") continue;
		const provider = entry.provider;
		const model = entry.model;
		if (typeof provider !== "string" || provider.length === 0) continue;
		if (typeof model !== "string" || model.length === 0) continue;
		const route = { provider, model };
		if (typeof entry.label === "string" && entry.label.length > 0) route.label = entry.label;
		chain.push(route);
	}
	return chain;
}

/**
 * 装好换线监听。
 * @param ctx - 插件上下文。
 * @param config - `enabled` / `chain` / `on` / `cooldownMs` / `notice`。
 */
function apply(ctx, config) {
	const settings = config ?? {};
	if (settings.enabled === false) {
		ctx.logger?.info?.("model-fallback: disabled by config");
		return;
	}
	const chain = readChain(settings.chain);
	if (chain.length === 0) {
		ctx.logger?.warn?.("model-fallback: chain is empty, plugin stays idle");
		return;
	}
	const codes = new Set(Array.isArray(settings.on) && settings.on.length > 0
		? settings.on.filter((code) => typeof code === "string")
		: DEFAULT_ON);
	const cooldownMs = typeof settings.cooldownMs === "number" ? settings.cooldownMs : DEFAULT_COOLDOWN_MS;
	const wantNotice = settings.notice !== false;

	/** 自动模式只认链首：走链首才由插件接管，别的路由都算你手选的，插件完全不插手。 */
	const entryKey = routeKey(chain[0].provider, chain[0].model);

	/** 冷却表：线路 key -> 解冻时间戳。只活在内存里，重启即清空。 */
	const cooling = new Map();
	/** 自己派发出去的请求，避免被本插件再次接管。 */
	const own = new WeakSet();

	function isCooling(route) {
		if (cooldownMs <= 0) return false;
		const key = routeKey(route.provider, route.model);
		const until = cooling.get(key);
		if (until === void 0) return false;
		if (until > Date.now()) return true;
		cooling.delete(key);
		return false;
	}

	function chill(route) {
		if (cooldownMs <= 0) return;
		cooling.set(routeKey(route.provider, route.model), Date.now() + cooldownMs);
	}

	function firstUsable(start) {
		if (cooldownMs <= 0) return start;
		for (let index = start; index < chain.length; index += 1) {
			if (!isCooling(chain[index])) return index;
		}
		return start;
	}

	function dispatch(options, route) {
		const request = { ...options, provider: route.provider, model: route.model };
		own.add(request);
		return ctx.llm.stream(request);
	}

	function noticeLine(notes, route, requestedModel) {
		const parts = notes.length === 0 ? [] : [notes.join("；")];
		parts.push(`这一轮走 ${routeName(route)}`);
		if (route.model !== requestedModel) parts.push("换了模型，口气可能不一样");
		return `〔自动换线〕${parts.join("；")}。\n\n`;
	}

	/**
	 * 全都没成时，把「试过哪几条、为什么停」补进交给 agent-loop 的报错文本。
	 * 只改 message，code 原样保留，上层仍按原错误码处理。
	 */
	function explain(failure, tried, why) {
		const finish = failure?.reason;
		const info = finish?.failure;
		if (info === void 0 || typeof info.message !== "string") return failure;
		const line = `\n\n〔自动换线〕按顺序试过 ${tried.join(" → ")}，${why}。`;
		return { ...failure, reason: { ...finish, failure: { ...info, message: `${info.message}${line}` } } };
	}

	async function* run(options, next) {
		const notes = [];
		const tried = [];
		const begin = firstUsable(0);
		if (begin > 0) notes.push(`上次 ${routeName(chain[0])} 失效，这次先跳过它`);
		let index = begin;
		let current = options;
		let primary = begin === 0;
		let noticePending = begin > 0;

		while (index < chain.length) {
			const route = chain[index];
			tried.push(routeName(route));
			const stream = primary ? next() : dispatch(current, route);
			primary = false;
			let failure;
			let visible = false;
			let toolDispatched = false;
			let maxIndex = -1;
			let pendingPrefix = [];
			let pendingTextStart;

			const flushPrefix = async function* () {
				for (const buffered of pendingPrefix) yield buffered;
				pendingPrefix = [];
			};

			for await (const chunk of stream) {
				if (chunk !== null && typeof chunk === "object") {
					if (chunk.type === "finish" && chunk.reason?.kind === "error") {
						failure = chunk;
						break;
					}
					if (typeof chunk.index === "number") maxIndex = Math.max(maxIndex, chunk.index);

					if (chunk.type === "usage") {
						yield chunk;
						continue;
					}
					if (chunk.type === "block-start" && chunk.blockType === "text") {
						pendingTextStart = chunk;
						continue;
					}
					if (chunk.type === "block-start" && (chunk.blockType === "reasoning" || chunk.blockType === "tool-call")) {
						pendingPrefix.push(chunk);
						if (chunk.blockType === "tool-call") toolDispatched = true;
						if (toolDispatched) {
							for await (const buffered of flushPrefix()) yield buffered;
							yield chunk;
						}
						continue;
					}
					if (chunk.type === "reasoning-delta") {
						pendingPrefix.push(chunk);
						continue;
					}
					if (chunk.type === "tool-call-delta") {
						toolDispatched = true;
						for await (const buffered of flushPrefix()) yield buffered;
						yield chunk;
						continue;
					}

					const hasText = chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text.length > 0;
					if (hasText) {
						if (!visible && noticePending && wantNotice) {
							for await (const buffered of flushPrefix()) yield buffered;
							if (pendingTextStart !== void 0) yield pendingTextStart;
							else yield { type: "block-start", index: chunk.index, blockType: "text" };
							yield { type: "text-delta", index: chunk.index, text: noticeLine(notes, route, options.model) };
						} else {
							for await (const buffered of flushPrefix()) yield buffered;
							if (pendingTextStart !== void 0) yield pendingTextStart;
						}
						pendingTextStart = void 0;
						visible = true;
					yield chunk;
						continue;
					}

					if (chunk.type === "block-end" && chunk.block?.type === "text") {
						const body = typeof chunk.block.text === "string" ? chunk.block.text : "";
						if (/\S/.test(body)) {
							for await (const buffered of flushPrefix()) yield buffered;
							if (pendingTextStart !== void 0) yield pendingTextStart;
							if (!visible && noticePending && wantNotice) {
								const text = noticeLine(notes, route, options.model);
								yield { type: "text-delta", index: chunk.index, text };
								yield { ...chunk, block: { ...chunk.block, text: `${text}${body}` } };
							} else {
								yield chunk;
							}
							pendingTextStart = void 0;
							visible = true;
							continue;
						}
						pendingPrefix.push(chunk);
						continue;
					}

					if (chunk.type === "block-start") {
						for await (const buffered of flushPrefix()) yield buffered;
						if (pendingTextStart !== void 0) {
							yield pendingTextStart;
							pendingTextStart = void 0;
						}
						visible = true;
						yield chunk;
						continue;
					}
				}

				if (chunk !== null && typeof chunk === "object" && chunk.type === "finish") {
					for await (const buffered of flushPrefix()) yield buffered;
					if (pendingTextStart !== void 0) {
						yield pendingTextStart;
						pendingTextStart = void 0;
					}
					if (!visible && !toolDispatched && noticePending && wantNotice) {
						const noticeIndex = maxIndex + 1;
						const text = noticeLine(notes, route, options.model);
						yield { type: "block-start", index: noticeIndex, blockType: "text" };
						yield { type: "text-delta", index: noticeIndex, text };
						yield { type: "block-end", index: noticeIndex, block: { type: "text", text } };
					}
					yield chunk;
					return;
				}
				yield chunk;
			}

			if (failure === void 0) return;
			const code = failure.reason?.failure?.code;
			const aborted = options.signal?.aborted === true || code === "ABORTED";
			if (visible || toolDispatched || aborted) {
				for await (const buffered of flushPrefix()) yield buffered;
				if (pendingTextStart !== void 0) yield pendingTextStart;
				yield failure;
				return;
			}
			if (code === "UNSUPPORTED_REASONING_EFFORT" && current.reasoningEffort !== void 0) {
				const stripped = { ...current };
				delete stripped.reasoningEffort;
				current = stripped;
				ctx.logger?.warn?.(`model-fallback: ${routeName(route)} rejected the reasoning effort, retrying with the default level`);
				continue;
			}
			chill(route);
			let nextIndex = index + 1;
			const skipped = [];
			while (nextIndex < chain.length && isCooling(chain[nextIndex])) {
				skipped.push(routeName(chain[nextIndex]));
				nextIndex += 1;
			}
			if (!codes.has(code)) {
				ctx.logger?.warn?.(`model-fallback: ${routeName(route)} failed (${code}); code is not in the switch list`);
				yield explain(failure, tried, `${code} 不在换线名单里`);
				return;
			}
			if (nextIndex >= chain.length) {
				const tail = skipped.length === 0 ? "" : `，${skipped.join("、")} 还在冷却里被跳过`;
				ctx.logger?.warn?.(`model-fallback: ${routeName(route)} failed (${code}); no route left to try`);
				yield explain(failure, tried, `${code} 之后没有可用的线路了${tail}`);
				return;
			}
			if (skipped.length > 0) notes.push(`${skipped.join("、")} 还在冷却，跳过`);
			ctx.logger?.warn?.(`model-fallback: ${routeName(route)} failed (${code}); switching to ${routeName(chain[nextIndex])}`);
			notes.push(`${routeName(route)} 失败（${code}）`);
			current = options;
			index = nextIndex;
			noticePending = true;
		}
	}

	ctx.on("llm/stream", (options, next) => {
		if (options === null || typeof options !== "object" || own.has(options)) return next();
		if (typeof options.provider !== "string" || typeof options.model !== "string") return next();
		if (routeKey(options.provider, options.model) !== entryKey) return next();
		return run(options, next);
	});
}

export { apply, inject, name };
