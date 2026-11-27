# dsh-model-fallback

给 DSH（DeepSeek Harness）用的模型线路自动降级插件。

一条线路不通就按顺序换下一条，重发的是**同一次请求**，用户看到的是正常的回复，开头多一行提示告诉你这一轮走了哪条线。

```
〔自动换线〕主线路 失败（QUOTA_EXCEEDED）；这一轮走 备用线路；换了模型，口气可能不一样。
```

## 为什么需要它

DSH 在 step 准备阶段就把模型固定下来了（`dsh-agent-loop` 里 `prepareRequest(turn, step, decision.selection, signal)`），自带的 `dsh-llm-retry` 只会在**同一条 route** 上重试。所以中转站某个分组挂了、账号额度用完了、模型临时不存在时，整轮就直接报错，不会自己换线。

这个插件挂在 `llm/stream` 中间件上，在适配器真正发请求之前接住，换一条线路重发，不改 DSH 本体。

## 行为规则

| 情况 | 插件做什么 |
| --- | --- |
| 请求走 `chain` 第一条（链首） | 接管。链首在吐出任何内容之前失败，就按顺序换下一条 |
| 请求走链里其它条 | 完全不介入，失败就直接报错 |
| 请求走链外模型 | 完全不介入 |
| 链首第一次失败 | 同一条线路再发一次（`attempts` 默认 2），不急着换线 |
| 链首两次都失败 | 记进内存冷却表，`cooldownMs`（默认 10 分钟）内跳过它，从下一条起走 |
| 冷却到期 | 重新从链首来一次 |
| `chain` 最后一条 | 兜底线路，**永不进冷却、也不被跳过**，中间全冷却时由它接 |

顺序表固定，永远从上往下走。

换线的边界条件（都是故意的）：

- **已经吐出正文才断的，不换线。** 否则两段回复会拼在一起，前后矛盾。
- **推理内容不算「吐出内容」。** 只有推理就失败的线路照常换下一条。
- **已经派发 `tool-call` 的不换。** 工具都跑了再重来会重复副作用。
- **用户主动取消（`ABORTED`）不换。**
- **`UNSUPPORTED_REASONING_EFFORT`** 先在同一条线路上去掉 `reasoningEffort` 重试一次，还不行才换线。
- 提示行兼容只发 delta、不发 `block-start` 的上游，也兼容先出推理再出正文的上游，提示只会进正文块。

## 配置

全部在 `cordis.patch.yml` 里。

```yaml
config:
  enabled: true          # 总开关，false 时完全不介入
  cooldownMs: 600000     # 一条线两次机会都用完还失败，跳过多久（毫秒），0 表示不跳过
  attempts: 2            # 每条线给几次机会，默认 2
  attemptMs: 120000      # 单次请求最多等多久（毫秒），0 表示不限
  budgetMs: 600000       # 整条链一共最多用多久（毫秒），0 表示不限
  notice: true           # 是否在回复开头留提示行
  on:                    # 只有这些错误码才换线
    - QUOTA_EXCEEDED
    - SERVER
  chain:                 # 顺序表，从上往下试
    - provider: your-provider-a
      model: your-model-a
      label: 主线路
    - provider: your-provider-b
      model: your-model-b
      label: 备用线路
```

`provider` / `model` 必须用 DSH 里**真实存在的** provider id 与模型 id。写虚的不会报错，但永远不会命中。

### 更省事的改法（不要动包里的文件）

直接改 `node_modules` 里那份 `cordis.patch.yml` 会在升级时被覆盖。推荐在自己 profile 的 patch 文件（`~/.dsh/profiles/<profile>/cordis.patch.yml`）里追加一条同 `id` 的覆盖：

```yaml
- id: model-fallback
  config:
    chain:
      - provider: 我的主线路
        model: 模型id
        label: 主线路
      - provider: 我的备用线路
        model: 模型id
        label: 备用线路
```

DSH 的补丁是「同 id 后写的覆盖先写的」，且 `config` 是整块替换。所以：

- 只写想改的字段就行，没写的走默认值：`enabled` 默认 `true`，`cooldownMs` 默认 `600000`，`attempts` 默认 `2`，`attemptMs` 默认 `120000`，`budgetMs` 默认 `600000`，`notice` 默认 `true`，`on` 默认上面那 14 个错误码。
- **`chain` 必须整条重写**，它不会和包里的示例链合并。
- 保存后一般会热生效；如果下一个请求还是没变化，重启一次 DSH。

provider id 与模型 id 在同一个 profile 文件的 `dsh-llm-pi-ai`（或对应适配器）下面的 `providers` 里，`provider` 是那一项的 key，`model` 是它 `models` 里的 id。模型下拉里看到的通常是显示名，不是 id。


### 默认触发的错误码

`UNKNOWN_MODEL`、`INVALID_REQUEST`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`QUOTA_EXCEEDED`、`MALFORMED_RESPONSE`、`EMPTY_RESPONSE`、`NO_ADAPTER`、`UNSUPPORTED_REASONING_EFFORT`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`LLM_STREAM_IDLE_TIMEOUT`、`TRANSPORT`。

`ABORTED`、上下文超长、图片不支持这一类不换。

## 安装

### 作为本地目录安装

1. 把这个目录放到长期位置，例如 `~/.dsh/local-plugins/dsh-model-fallback`。
2. 在 profile 的 `package.json`（`~/.dsh/profiles/<profile>/package.json`）里加依赖与 bundle：

   ```json
   {
     "dependencies": {
       "dsh-model-fallback": "link:../../local-plugins/dsh-model-fallback"
     },
     "dsh": {
       "profile": {
         "bundles": ["...", "dsh-model-fallback"]
       }
     }
   }
   ```

3. 在 profile 目录里跑 `pnpm install`。
4. 在插件页确认 `dsh-model-fallback` 已启用，然后**重启 DSH**。模块代码的改动必须重启才生效，热重载只对配置生效。

### 从 GitHub 安装

本仓库没有发布到 npm（`dsh-model-fallback` 这个 npm 名字属于别人，直接 `plugin add dsh-model-fallback` 会装到另一个插件）。用 GitHub 地址装：

```bash
dsh --profile <profile> plugin add github:fhmxz/dsh-model-fallback#v1.0.0
```

或者把仓库克隆下来，按上一节「作为本地目录安装」的做法用 `link:` 挂上去。装完同样要重启。

## 注意

- 冷却表只在内存里，重启 DSH 会清空。
- 会话记录里显示的模型名永远是**发起请求的那条线路**，实际作答的可能是备用线路，靠提示行区分。
- 这一轮的用量与成本会按主线路记账。
- 全部线路都没试成功时，报错文本末尾会补一行「按顺序试过 A → B → C」，原来的错误码不变。
- 手选的模型失败不会进冷却表，等你切回链首，链子还是照常先试链首。
- 链尾那条兜底线路永远不进冷却。它要是也挂了，每一轮都会多试它一次，这是故意的。
- 超时按失败处理：单条线路超过 `attemptMs` 没有任何回应就放掉，按「还有机会」再发一次或换线，并记 `TIMEOUT`；整条链超过 `budgetMs` 就直接报错，不再往后试。
- 同一条线上的重试不计入「试过哪几条」，提示行里每条线路的名字只出现一次；只有两次机会都用尽，才会写进提示和冷却表。

## 测试

```bash
node test/harness.mjs
```

先跑 `node test/patch.mjs`，它检查 `cordis.patch.yml` 的缩进结构，有 YAML 解析器时还会真解析一遍（没装就只做结构检查）。这一条是给改配置的人兜底的：缩进写错时 DSH 会直接跳过整个插件，日志里只说一句 bad indentation。

然后是 21 项用例，覆盖换线、半截不换、手选不介入、冷却过期与递进跳过、链尾兜底不被冷却、单次超时换线、总时限收手、降档重试、全挂报错、delta-only 与先推理后正文等流形态。测试用桩 ctx 模拟 `llm/stream` 瀑布，不连真实模型。

## License

MIT

---

### English

A DSH plugin that fails over between model routes. If the head route of `chain` fails before emitting any visible content, the same request is re-dispatched to the next route and a one-line notice is prepended. Manually selected models outside the head route are left completely alone. Cooldown is in-memory; the chain order is fixed.
