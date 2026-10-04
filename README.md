# dsh-flight-compare

DSH 插件：注册 `flight_compare` 工具，从 Travelpayouts 获取单条航线的缓存机票价格，按「航班号 + 日期」聚合，标出每组最低价，并按价格升序输出 Markdown 表格。

## 安装

```bash
cd dsh-flight-compare
pnpm install
pnpm build
```

## 配置

token 从插件配置读取，插件通过 `cordis.patch.yml` 从环境变量取，不要在代码里硬编码：

```bash
export TRAVELPAYOUTS_TOKEN="<your-travelpayouts-token>"
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `token` | `process.env.TRAVELPAYOUTS_TOKEN` | Travelpayouts API token，必填，作为 `X-Access-Token` 请求头发送。 |
| `currency` | `RUB` | 价格币种，例如 `RUB`、`USD`。 |
| `maxRows` | `30` | 输出表格的最大行数。 |
| `timeoutMs` | `20000` | 单次 Travelpayouts 请求的超时时间（毫秒）。 |

覆盖默认值（`cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-flight-compare
      name: dsh-flight-compare
      config:
        token: !!js process.env.TRAVELPAYOUTS_TOKEN
        currency: USD
        maxRows: 30
```

## 本地调试

`--patch` 是 launcher 的 flag，必须跟在 `--profile` 之后（`dsh <name>` 是 `dsh --profile <name>` 的简写），补丁路径相对当前目录解析：

```bash
export TRAVELPAYOUTS_TOKEN="<your-travelpayouts-token>"

# 在插件目录里启动当前 profile，并叠加这个补丁层
cd dsh-flight-compare
dsh --profile web --patch ./cordis.patch.yml
```

`--profile web` 换成实际要启动的 profile 名字即可（例如 `dsh tui --patch ./cordis.patch.yml`）。补丁里的 `name: dsh-flight-compare` 由 profile 的 `node_modules` 解析，所以先用 `dsh plugin --profile <profile> add <本目录绝对路径>` 把包装进 profile：

```bash
dsh plugin --profile web add "$(pwd)"
```

先确认组合结果再启动：

```bash
dsh --profile web --patch ./cordis.patch.yml --dump-config
```
