# 风险 SN 分拣看板

这是一个纯静态网页，可部署到 Vercel、Netlify、Cloudflare Pages、GitHub Pages、Nginx 或任何静态文件服务器。

## 数据链路

- `Warehouse_Config`：出库/调拨配置，页面优先使用 `海外仓入库单` 匹配风险清单，补充批次、发货批次和收货仓库。
- `Risk_SN_list`：风险 SN 主清单，页面使用 `出货SN\n（为空是因为产品不良、或者没包装）` 作为唯一风险 SN。
- `scan_events`：实时扫码事件，页面按扫码 SN 匹配风险清单，按唯一 SN 计算已分拣进度。

## 匹配规则

1. `Risk_SN_list.入库单号` 匹配 `Warehouse_Config.海外仓入库单`。
2. 入库单号为空、`#N/A`、`0`、`亚马逊` 等不稳定值时，回退到 `上游出库单号 + SKU`。
3. `scan_events` 的 SN 字段会自动识别常见字段名，如 `出货SN`、`扫码SN`、`SN`、`sn`、`barcode`、`scan_value`。
4. 如果 `scan_events` 字段名不在默认候选里，页面会尝试从字段值中自动推断哪个字段能匹配风险 SN。
5. 已分拣和不良数量按唯一风险 SN 计数；重复扫码不会重复累加。
6. 当前扫码表字段 `sn / result / warehouse_code / operator_name / scanned_at` 已适配；`result = risk` 会计入不良，`result = safe` 不计入不良。
7. `scan_events` 里标识为测试的记录会被排除：`is_test = true`、`test_tag` 有值、或 `raw_payload.test_device = true` 均不计入进度。
8. `扫码上报看板` 按 `scan_events` 原始记录统计扫描总数；仓库和 SKU 口径优先通过扫码 SN 反查 `Risk_SN_list`，再匹配调拨配置得到入库仓。未命中风险清单但可识别的扫码，会优先用当前时间段的 `device_id` 反推入库仓、用 SN 前缀识别 SKU，并按 SKU 关联品名。
9. `扫码上报看板` 支持 `按SKU` / `按批次` 切换。按批次时会细化到 `时间段 + 入库仓 + SKU + 批次`；safe 或未配置批次的记录会优先合并到同时间段、同仓、同 SKU 的唯一明确批次，无法唯一判断时显示为 `按SKU汇总`。

## 部署

直接部署本目录的运行文件：

- `index.html`
- `styles.css`
- `app.js`
- `password-config.json`
- `manual-completed-batches.json`

Supabase URL 和 publishable key 已写在 `app.js` 顶部。publishable key 可以放在前端；不要把 service role key 放进页面代码。

## 手动配置

- `manual-completed-batches.json` 是部署包内的静态手动标记数据源。页面每次刷新时会和 Supabase 数据一起读取它。
- 静态手动标记按 `发货批次 + 入库单号 + 上游出库单号 + SKU` 匹配 `Risk_SN_list`，匹配到的风险 SN 会显示为 `手动标记`，并计入已分拣和不良数量。
- 如果同一发货批次的静态手动标记 SN 已经出现在 `scan_events`，该发货批次会整批按云端扫码记录优先，不再用文件补标覆盖。
- 静态手动标记不会写入 Supabase。要调整固定批次，直接修改 `manual-completed-batches.json` 后重新部署。
- 页面右上角 `手动配置` 入口需要密码登录，默认密码是 `admin123`。
- 密码配置在 `password-config.json`，当前使用 SHA-256 hex。要改密码，把新密码做 SHA-256 后替换 `passwordHash`。
- 手动配置不会写入 Supabase，只保存在当前浏览器的 `localStorage`。
- 手动配置按 `仓库 + 批次 + 实际不良数量` 生效：页面会先扣除云端已匹配的不良扫码，只把差额补标为 `手动配置`。
- 可以在面板里导出 / 导入手动配置 JSON，用于换电脑或部署同步。

PowerShell 生成新密码 hash 示例：

```powershell
$bytes=[System.Text.Encoding]::UTF8.GetBytes('your-new-password')
$hash=[System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
[BitConverter]::ToString($hash).Replace('-','').ToLowerInvariant()
```

## Supabase 要求

- 三张表需要允许 publishable key 对应角色执行 `select`。
- 如果需要毫秒级实时刷新，`scan_events` 需要开启 Supabase Realtime。未开启时页面仍会每 60 秒轮询刷新。
- `scan_events` 当前为空也可以正常运行；有新扫码记录后会自动进入看板。

如果 Supabase Studio 能看到 `scan_events` 记录，但网页显示为 0，通常是 `scan_events` 的 RLS / API policy 没有允许 publishable key 对应的 `anon` 角色读取。可以在 SQL Editor 检查并按需开放只读策略：

```sql
grant usage on schema public to anon;
grant select on public.scan_events to anon;

alter table public.scan_events enable row level security;

create policy "Allow anon read scan events"
on public.scan_events
for select
to anon
using (true);
```

如果扫码记录不适合公开读取，不要把 service role key 放进前端。建议创建一个只暴露必要字段的 view / RPC，再只给这个 view / RPC 开放 `select`。
