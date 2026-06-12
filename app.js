const SUPABASE_URL = "https://iskiqnpsyxxmfdxnxebx.supabase.co";
const SUPABASE_KEY = "sb_publishable_yXKeWtM3oCR9q2szpf6BKQ_GKVSbH3J";

const TABLES = {
  warehouse: "Warehouse_Config",
  risk: "Risk_SN_list",
  scans: "scan_events",
};

const PASSWORD_CONFIG_URL = "./password-config.json";
const STATIC_MANUAL_CONFIG_URL = "./manual-completed-batches.json";
const DEFAULT_PASSWORD_HASH = "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9";
const MANUAL_STORAGE_KEY = "warehouse-progress-dashboard.manual-overrides.v1";
const SESSION_STORAGE_KEY = "warehouse-progress-dashboard.manual-session.v1";

const FIELDS = {
  warehouse: {
    inbound: "海外仓入库单",
    upstream: "上游出库单号",
    sku: "SKU",
    batch: "批次号",
    shipBatch: "发货批次",
    warehouse: "收货仓库",
    shippedQty: "实际发货量",
    owner: "海外仓配负责人",
  },
  risk: {
    sn: "出货SN\n（为空是因为产品不良、或者没包装）",
    inbound: "入库单号",
    upstream: "上游出库单号",
    sku: "SKU",
    destination: "最终目的仓",
    machine: "机器码",
    itemName: "物料名称",
    wms: "WMS出库单号",
    carton: "外箱条码",
    owner: "负责人",
  },
  scans: {
    sn: [
      "出货SN",
      "风险SN",
      "扫码SN",
      "扫描SN",
      "SN",
      "sn",
      "serial_number",
      "serialNumber",
      "risk_sn",
      "shipment_sn",
      "scan_sn",
      "barcode",
      "条码",
      "扫描内容",
      "scan_value",
      "scan_text",
      "机器码",
      "外箱条码",
    ],
    time: [
      "created_at",
      "scanned_at",
      "scan_time",
      "扫码时间",
      "扫描时间",
      "timestamp",
      "time",
      "updated_at",
    ],
    warehouse: [
      "warehouse",
      "warehouse_code",
      "scan_warehouse",
      "仓库",
      "扫码仓库",
      "扫描仓库",
      "收货仓库",
      "最终目的仓",
      "destination_warehouse",
    ],
    operator: ["operator", "operator_name", "scanner", "扫码人", "扫描人", "负责人", "user", "created_by"],
    status: ["status", "result", "结果", "判定", "质检结果", "良品状态", "状态"],
    bad: ["is_bad", "bad", "defective", "is_defective", "ng", "不良", "是否不良", "不良品"],
  },
};

const PAGE_SIZE = 1000;
const INVALID_KEYS = new Set(["", "#N/A", "N/A", "NA", "NULL", "UNDEFINED", "-", "0", "亚马逊"]);
const MAX_TABLE_ROWS = 600;
const RECENT_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const state = {
  client: null,
  warehouseRows: [],
  riskRows: [],
  scanRows: [],
  staticManualRules: [],
  manualOverrides: [],
  manualAuthenticated: false,
  editingManualId: "",
  passwordConfig: null,
  model: null,
  filteredRows: [],
  filters: {
    warehouse: "",
    batch: "",
    inbound: "",
    status: "",
    search: "",
  },
  scanPeriodMode: "day",
  refreshTimer: null,
  toastTimer: null,
};

const nf = new Intl.NumberFormat("zh-CN");
const pctf = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 1,
});

const $ = (id) => document.getElementById(id);

window.addEventListener("DOMContentLoaded", init);

async function init() {
  state.manualOverrides = loadManualOverrides();
  state.manualAuthenticated = window.sessionStorage.getItem(SESSION_STORAGE_KEY) === "authenticated";
  bindControls();
  renderManualAuthState();
  renderIcons();

  if (!window.supabase?.createClient) {
    showFatal("Supabase 客户端未加载，检查部署环境是否允许访问 CDN。");
    return;
  }

  state.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: { params: { eventsPerSecond: 4 } },
  });

  await loadAllData();
  subscribeToRealtime();
  window.setInterval(refreshScanEvents, 60000);
}

function bindControls() {
  $("refreshBtn").addEventListener("click", loadAllData);
  $("resetBtn").addEventListener("click", resetFilters);
  $("exportBtn").addEventListener("click", exportFilteredCsv);
  $("manualConfigBtn").addEventListener("click", openManualModal);
  $("manualCloseBtn").addEventListener("click", closeManualModal);
  $("manualLoginForm").addEventListener("submit", handleManualLogin);
  $("manualOverrideForm").addEventListener("submit", handleManualOverrideSave);
  $("manualFormResetBtn").addEventListener("click", resetManualForm);
  $("manualExportBtn").addEventListener("click", exportManualOverrides);
  $("manualImportFile").addEventListener("change", importManualOverrides);
  $("manualLogoutBtn").addEventListener("click", logoutManualConfig);
  $("manualWarehouseInput").addEventListener("change", updateManualBatchOptions);
  $("manualOverrideList").addEventListener("click", handleManualListClick);
  document.querySelectorAll("[data-scan-period]").forEach((button) => {
    button.addEventListener("click", () => {
      state.scanPeriodMode = button.dataset.scanPeriod || "day";
      renderFromModel();
    });
  });

  $("manualModal").addEventListener("click", (event) => {
    if (event.target === $("manualModal")) closeManualModal();
  });

  for (const [id, key] of [
    ["warehouseFilter", "warehouse"],
    ["batchFilter", "batch"],
    ["inboundFilter", "inbound"],
    ["statusFilter", "status"],
    ["searchFilter", "search"],
  ]) {
    const input = $(id);
    input.addEventListener("input", () => {
      state.filters[key] = input.value.trim();
      renderFromModel();
    });
    input.addEventListener("change", () => {
      state.filters[key] = input.value.trim();
      renderFromModel();
    });
  }
}

async function loadAllData() {
  setLoading(true);
  setConnection("同步中", "info");
  try {
    const [warehouseRows, riskRows, scanRows, staticManualRules] = await Promise.all([
      fetchAllRows(TABLES.warehouse),
      fetchAllRows(TABLES.risk),
      fetchAllRows(TABLES.scans),
      fetchStaticManualRules(),
    ]);

    state.warehouseRows = warehouseRows;
    state.riskRows = riskRows;
    state.scanRows = scanRows;
    state.staticManualRules = staticManualRules;
    state.model = buildModel();
    updateFilterOptions();
    renderFromModel();
    setConnection("已连接", "good");
    showToast("数据已刷新");
  } catch (error) {
    setConnection("读取失败", "bad");
    showToast(error.message || "读取 Supabase 失败");
    renderErrors(error);
  } finally {
    setLoading(false);
  }
}

async function refreshScanEvents() {
  if (!state.client || !state.riskRows.length) return;
  try {
    const scanRows = await fetchAllRows(TABLES.scans);
    state.scanRows = scanRows;
    state.model = buildModel();
    renderFromModel();
    setConnection("已连接", "good");
  } catch (error) {
    setConnection("刷新失败", "warn");
    showToast(error.message || "刷新 scan_events 失败");
  }
}

async function fetchAllRows(tableName) {
  const rows = [];
  let from = 0;

  for (let page = 0; page < 120; page += 1) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await state.client.from(tableName).select("*").range(from, to);
    if (error) throw new Error(`${tableName}: ${error.message}`);

    const pageRows = data || [];
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
}

async function fetchStaticManualRules() {
  try {
    const response = await fetch(STATIC_MANUAL_CONFIG_URL, { cache: "no-store" });
    if (!response.ok) return [];
    const config = await response.json();
    const rules = Array.isArray(config) ? config : config.completedBatches;
    if (!Array.isArray(rules)) return [];
    return rules.map(normalizeStaticManualRule).filter(Boolean);
  } catch (error) {
    return [];
  }
}

function normalizeStaticManualRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  const shipBatch = clean(rule.shipBatch || rule["发货批次"]);
  const inbound = clean(rule.inbound || rule["入库单号"]);
  const upstream = clean(rule.upstream || rule["上游出库单号"]);
  const sku = clean(rule.sku || rule["SKU"]);
  if (!shipBatch && !inbound && !upstream && !sku) return null;

  return {
    id: clean(rule.id) || [shipBatch, inbound, upstream, sku].filter(Boolean).join("|"),
    shipBatch,
    inbound,
    upstream,
    sku,
    warehouse: clean(rule.warehouse || rule["海外仓"]),
    destination: clean(rule.destination || rule["最终目的仓(含亚马逊拦截）"]),
    owner: clean(rule.owner || rule["负责人"]),
    carrier: clean(rule.carrier || rule["承运商"]),
    itemName: clean(rule.itemName || rule["品名"]),
    riskCount: Math.max(0, Math.floor(Number(rule.riskCount ?? rule["风险数量"]) || 0)),
    goodCount: Math.max(0, Math.floor(Number(rule.goodCount ?? rule["良品数量"]) || 0)),
    badCount: Math.max(0, Math.floor(Number(rule.badCount ?? rule["不良品数量"]) || 0)),
    status: clean(rule.status || rule["清点状态"]),
    updatedAt: clean(rule.updatedAt) || "static-config",
  };
}

function subscribeToRealtime() {
  if (!state.client) return;

  state.client
    .channel("warehouse-scan-events-dashboard")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: TABLES.scans },
      () => {
        setConnection("实时同步", "info");
        window.clearTimeout(state.refreshTimer);
        state.refreshTimer = window.setTimeout(refreshScanEvents, 500);
      },
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setConnection("实时已订阅", "good");
      if (status === "CHANNEL_ERROR") setConnection("实时不可用", "warn");
      if (status === "TIMED_OUT") setConnection("订阅超时", "warn");
      if (status === "CLOSED") setConnection("订阅关闭", "warn");
    });
}

function buildModel() {
  const configIndex = buildConfigIndex(state.warehouseRows);
  const riskSnSet = new Set();

  const baseRiskRows = state.riskRows.map((row, index) => {
    const sn = clean(row[FIELDS.risk.sn]);
    const snKey = normalizeSn(sn);
    if (snKey) riskSnSet.add(snKey);

    const match = matchWarehouseConfig(row, configIndex);
    const config = match?.row || {};
    const batch = displayValue(config[FIELDS.warehouse.batch], "未配置批次");
    const shipBatch = displayValue(config[FIELDS.warehouse.shipBatch], "");
    const riskDestination = displayValue(row[FIELDS.risk.destination], "未配置仓库");
    const warehouse = displayValue(config[FIELDS.warehouse.warehouse], riskDestination);
    const inbound = clean(row[FIELDS.risk.inbound]);

    return {
      index,
      raw: row,
      sn,
      snKey,
      hasSn: Boolean(snKey),
      machine: clean(row[FIELDS.risk.machine]),
      inbound,
      upstream: clean(row[FIELDS.risk.upstream]),
      sku: clean(row[FIELDS.risk.sku]),
      itemName: clean(row[FIELDS.risk.itemName]),
      destination: clean(row[FIELDS.risk.destination]),
      batch,
      shipBatch,
      warehouse,
      configMatched: Boolean(match),
      configMatchMode: match?.mode || "none",
      scanned: false,
      bad: false,
      eventCount: 0,
      latestEvent: null,
    };
  });

  const activeScanRows = state.scanRows.filter((row) => !isTestScanRow(row));
  const excludedTestScanRows = state.scanRows.length - activeScanRows.length;
  const scanFields = resolveScanFields(activeScanRows, riskSnSet);
  const scanEvents = normalizeScanEvents(activeScanRows, scanFields);
  const eventsBySn = new Map();

  for (const event of scanEvents) {
    if (!event.snKey) continue;
    if (!eventsBySn.has(event.snKey)) eventsBySn.set(event.snKey, []);
    eventsBySn.get(event.snKey).push(event);
  }

  for (const events of eventsBySn.values()) {
    events.sort(compareEventsAscending);
  }

  const enrichedRows = baseRiskRows.map((row) => {
    const events = row.snKey ? eventsBySn.get(row.snKey) || [] : [];
    const latestEvent = events.at(-1) || null;
    return {
      ...row,
      scanned: events.length > 0,
      bad: Boolean(latestEvent?.bad),
      eventCount: events.length,
      latestEvent,
      manual: false,
      manualSource: "",
      manualOverrideId: "",
    };
  });

  const staticManualSummary = applyStaticManualRules(enrichedRows);
  const manualSummary = applyManualOverrides(enrichedRows);
  const unmatchedEvents = scanEvents.filter((event) => event.snKey && !riskSnSet.has(event.snKey));
  const eventSnCounts = [...eventsBySn.values()].filter((events) => events.length > 1).length;
  const rowsWithoutConfig = enrichedRows.filter((row) => !row.configMatched).length;

  return {
    rows: enrichedRows,
    scanFields,
    scanEvents,
    excludedTestScanRows,
    staticManualSummary,
    staticManualAppliedRows: staticManualSummary.applied,
    manualSummary,
    localManualAppliedRows: manualSummary.applied,
    manualAppliedRows: manualSummary.applied + staticManualSummary.applied,
    unmatchedEvents,
    duplicateScanSnCount: eventSnCounts,
    rowsWithoutConfig,
    configOnlyInbounds: configIndex.configOnlyInbounds,
    loadedAt: new Date(),
  };
}

function applyManualOverrides(rows) {
  const summary = {
    applied: 0,
    configured: state.manualOverrides.length,
    items: [],
  };

  for (const override of state.manualOverrides) {
    const targetBadCount = Math.max(0, Math.floor(Number(override.badCount) || 0));
    const groupRows = rows
      .filter((row) => row.hasSn && row.warehouse === override.warehouse && row.batch === override.batch)
      .sort((a, b) => (a.sn || "").localeCompare(b.sn || "", "zh-CN"));
    const cloudBadCount = groupRows.filter((row) => row.scanned && row.bad).length;
    const manualNeeded = Math.max(0, targetBadCount - cloudBadCount);
    const candidates = groupRows.filter((row) => !row.scanned);
    const appliedRows = candidates.slice(0, manualNeeded);

    for (const row of appliedRows) {
      row.scanned = true;
      row.bad = true;
      row.manual = true;
      row.manualSource = "local";
      row.manualOverrideId = override.id;
      row.latestEvent = {
        time: override.updatedAt || "",
        warehouse: "手动配置",
        operator: "manual",
        bad: true,
        manual: true,
      };
    }

    summary.applied += appliedRows.length;
    summary.items.push({
      id: override.id,
      warehouse: override.warehouse,
      batch: override.batch,
      targetBadCount,
      cloudBadCount,
      applied: appliedRows.length,
      shortage: Math.max(0, manualNeeded - appliedRows.length),
    });
  }

  return summary;
}

function applyStaticManualRules(rows) {
  const summary = {
    applied: 0,
    configured: state.staticManualRules.length,
    skipped: 0,
    scanEventPriorityBatches: 0,
    items: [],
  };
  const ruleMatches = state.staticManualRules.map((rule) => {
    const matchedRows = rows
      .filter((row) => row.hasSn && matchesStaticManualRule(row, rule))
      .sort((a, b) => (a.sn || "").localeCompare(b.sn || "", "zh-CN"));
    const cloudOverlapCount = matchedRows.filter((row) => row.eventCount > 0).length;
    return {
      rule,
      matchedRows,
      cloudOverlapCount,
      shipBatchKey: normalizeKey(rule.shipBatch),
    };
  });
  const scanEventPriorityShipBatches = new Set(
    ruleMatches
      .filter((item) => item.shipBatchKey && item.cloudOverlapCount > 0)
      .map((item) => item.shipBatchKey),
  );
  summary.scanEventPriorityBatches = scanEventPriorityShipBatches.size;

  for (const item of ruleMatches) {
    const { rule, matchedRows, cloudOverlapCount, shipBatchKey } = item;
    const skippedByScanEvents = shipBatchKey
      ? scanEventPriorityShipBatches.has(shipBatchKey)
      : cloudOverlapCount > 0;
    let applied = 0;

    if (skippedByScanEvents) {
      summary.skipped += 1;
      summary.items.push({
        id: rule.id,
        shipBatch: rule.shipBatch,
        inbound: rule.inbound,
        upstream: rule.upstream,
        sku: rule.sku,
        expectedRiskCount: rule.riskCount,
        matched: matchedRows.length,
        applied: 0,
        cloudOverlapCount,
        skippedByScanEvents: true,
      });
      continue;
    }

    for (const row of matchedRows) {
      if (!row.manual || row.manualSource !== "file") applied += 1;
      row.scanned = true;
      row.bad = true;
      row.manual = true;
      row.manualSource = "file";
      row.manualOverrideId = rule.id;
      row.latestEvent = {
        time: rule.updatedAt || "",
        warehouse: "手动标记",
        operator: "file",
        bad: true,
        manual: true,
      };
    }

    summary.applied += applied;
    summary.items.push({
      id: rule.id,
      shipBatch: rule.shipBatch,
      inbound: rule.inbound,
      upstream: rule.upstream,
      sku: rule.sku,
      expectedRiskCount: rule.riskCount,
      matched: matchedRows.length,
      applied,
      cloudOverlapCount,
      skippedByScanEvents: false,
    });
  }

  return summary;
}

function matchesStaticManualRule(row, rule) {
  if (rule.shipBatch && normalizeKey(row.shipBatch) !== normalizeKey(rule.shipBatch)) return false;
  if (rule.inbound && normalizeKey(row.inbound) !== normalizeKey(rule.inbound)) return false;
  if (rule.upstream && normalizeKey(row.upstream) !== normalizeKey(rule.upstream)) return false;
  if (rule.sku && normalizeKey(row.sku) !== normalizeKey(rule.sku)) return false;
  if (rule.warehouse && normalizeKey(row.warehouse) !== normalizeKey(rule.warehouse)) return false;
  return true;
}

function isTestScanRow(row) {
  if (!row || typeof row !== "object") return false;
  if (parseBooleanLike(row.is_test)) return true;
  if (hasMeaningfulTestTag(row.test_tag)) return true;

  const payload = row.raw_payload;
  if (payload && typeof payload === "object" && parseBooleanLike(payload.test_device)) return true;

  return false;
}

function buildConfigIndex(rows) {
  const byInbound = new Map();
  const byUpstreamSku = new Map();
  const validInbounds = new Set();

  for (const row of rows) {
    const inbound = normalizeKey(row[FIELDS.warehouse.inbound]);
    const upstreamSku = compositeKey(row[FIELDS.warehouse.upstream], row[FIELDS.warehouse.sku]);

    if (isValidKey(inbound)) {
      validInbounds.add(inbound);
      pushToMap(byInbound, inbound, row);
    }
    if (upstreamSku) pushToMap(byUpstreamSku, upstreamSku, row);
  }

  const riskInbounds = new Set(
    state.riskRows
      .map((row) => normalizeKey(row[FIELDS.risk.inbound]))
      .filter(isValidKey),
  );
  const configOnlyInbounds = [...validInbounds].filter((key) => !riskInbounds.has(key));

  return { byInbound, byUpstreamSku, configOnlyInbounds };
}

function matchWarehouseConfig(riskRow, configIndex) {
  const inbound = normalizeKey(riskRow[FIELDS.risk.inbound]);
  const upstreamSku = compositeKey(riskRow[FIELDS.risk.upstream], riskRow[FIELDS.risk.sku]);

  if (isValidKey(inbound) && configIndex.byInbound.has(inbound)) {
    const candidates = configIndex.byInbound.get(inbound);
    const exact = upstreamSku
      ? candidates.find((row) => compositeKey(row[FIELDS.warehouse.upstream], row[FIELDS.warehouse.sku]) === upstreamSku)
      : null;
    return { row: exact || candidates[0], mode: exact ? "入库单+SKU" : "入库单" };
  }

  if (upstreamSku && configIndex.byUpstreamSku.has(upstreamSku)) {
    return { row: configIndex.byUpstreamSku.get(upstreamSku)[0], mode: "上游出库单+SKU" };
  }

  return null;
}

function normalizeScanEvents(rows, scanFields) {
  return rows.map((row, index) => {
    const rawSn = scanFields.sn ? row[scanFields.sn] : "";
    const rawTime = scanFields.time ? row[scanFields.time] : row.created_at || row.updated_at || "";
    const timestamp = parseTimestamp(rawTime);

    return {
      index,
      raw: row,
      rawSn: clean(rawSn),
      snKey: normalizeSn(rawSn),
      time: rawTime ? clean(rawTime) : "",
      timestamp,
      warehouse: scanFields.warehouse ? clean(row[scanFields.warehouse]) : "",
      operator: scanFields.operator ? clean(row[scanFields.operator]) : "",
      bad: detectBad(row, scanFields),
    };
  });
}

function resolveScanFields(rows, riskSnSet) {
  const keys = getAllKeys(rows);
  const picked = {
    sn: pickExisting(keys, FIELDS.scans.sn),
    time: pickExisting(keys, FIELDS.scans.time),
    warehouse: pickExisting(keys, FIELDS.scans.warehouse),
    operator: pickExisting(keys, FIELDS.scans.operator),
    status: pickExisting(keys, FIELDS.scans.status),
    bad: pickExisting(keys, FIELDS.scans.bad),
    keys,
  };

  if (!picked.sn && rows.length && riskSnSet.size) {
    picked.sn = inferSnField(rows, keys, riskSnSet);
  }

  return picked;
}

function inferSnField(rows, keys, riskSnSet) {
  let bestField = "";
  let bestScore = 0;
  const sampleRows = rows.slice(0, 5000);

  for (const key of keys) {
    let score = 0;
    for (const row of sampleRows) {
      if (riskSnSet.has(normalizeSn(row[key]))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestField = key;
    }
  }

  return bestScore > 0 ? bestField : "";
}

function detectBad(row, scanFields) {
  if (scanFields.bad && parseBadValue(row[scanFields.bad], true)) return true;
  if (scanFields.status && parseBadValue(row[scanFields.status], false)) return true;

  for (const key of Object.keys(row)) {
    if (!/bad|defect|ng|不良|次品|异常|失败|fail/i.test(key)) continue;
    if (parseBadValue(row[key], true)) return true;
  }

  return false;
}

function parseBadValue(value, booleanAllowed) {
  if (typeof value === "boolean") return booleanAllowed ? value : false;
  if (typeof value === "number") return booleanAllowed ? value !== 0 : false;

  const text = clean(value).toLowerCase();
  if (!text) return false;
  if (/^(false|0|no|n|否|良品|合格|正常|ok|pass|passed|good)$/.test(text)) return false;
  if (/^(true|1|yes|y|是)$/.test(text)) return booleanAllowed;
  return /(不良|次品|ng|bad|risk|risky|unsafe|fail|failed|defect|damaged|异常|报废|拦截)/i.test(text);
}

function parseBooleanLike(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = clean(value).toLowerCase();
  return /^(true|1|yes|y|是|test|测试)$/.test(text);
}

function hasMeaningfulTestTag(value) {
  const text = clean(value).toLowerCase();
  if (!text) return false;
  return !/^(false|0|no|n|否|null|none|undefined)$/.test(text);
}

function renderFromModel() {
  if (!state.model) return;

  const filteredRows = applyFilters(state.model.rows);
  state.filteredRows = filteredRows;
  const stats = computeStats(filteredRows, state.model);
  const groupStats = computeGroupStats(filteredRows);
  const warehouseStats = computeWarehouseStats(filteredRows);
  const scanPeriodStats = computeScanPeriodStats(state.model, state.filters);

  renderKpis(stats);
  renderBatchList(groupStats);
  renderWarehouseChart(warehouseStats);
  renderScanPeriodBoard(scanPeriodStats);
  renderRiskTable(filteredRows);
  renderExceptions(stats, state.model);
  renderHeader(stats);
  renderManualPanel();
  renderIcons();
}

function applyFilters(rows) {
  const filters = state.filters;
  const search = normalizeSearch(filters.search);
  const inbound = normalizeSearch(filters.inbound);

  return rows.filter((row) => {
    if (filters.warehouse && row.warehouse !== filters.warehouse) return false;
    if (filters.batch && row.batch !== filters.batch) return false;
    if (inbound && !normalizeSearch(row.inbound).includes(inbound)) return false;

    if (filters.status === "missing" && (!row.hasSn || row.scanned)) return false;
    if (filters.status === "scanned" && !row.scanned) return false;
    if (filters.status === "bad" && !row.bad) return false;
    if (filters.status === "manual" && !row.manual) return false;
    if (filters.status === "duplicate" && row.eventCount < 2) return false;
    if (filters.status === "blank" && row.hasSn) return false;
    if (filters.status === "noConfig" && row.configMatched) return false;

    if (search) {
      const haystack = normalizeSearch(
        [
          row.sn,
          row.machine,
          row.inbound,
          row.upstream,
          row.sku,
          row.itemName,
          row.batch,
          row.shipBatch,
          row.warehouse,
          row.destination,
        ].join(" "),
      );
      if (!haystack.includes(search)) return false;
    }

    return true;
  });
}

function computeStats(rows, model) {
  const scanable = rows.filter((row) => row.hasSn).length;
  const scanned = rows.filter((row) => row.hasSn && row.scanned).length;
  const bad = rows.filter((row) => row.hasSn && row.scanned && row.bad).length;
  const blank = rows.filter((row) => !row.hasSn).length;
  const missing = rows.filter((row) => row.hasSn && !row.scanned).length;
  const duplicate = rows.filter((row) => row.eventCount > 1).length;
  const withoutConfig = rows.filter((row) => !row.configMatched).length;
  const manual = rows.filter((row) => row.manual).length;

  return {
    rowsTotal: rows.length,
    scanable,
    scanned,
    bad,
    blank,
    missing,
    duplicate,
    withoutConfig,
    manual,
    progress: ratio(scanned, scanable),
    badRate: ratio(bad, scanned),
    missingRate: ratio(missing, scanable),
    unmatchedEvents: model.unmatchedEvents.length,
    totalEvents: model.scanEvents.length,
  };
}

function computeGroupStats(rows) {
  const groups = new Map();

  for (const row of rows) {
    const key = `${row.batch}|||${row.warehouse}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        batch: row.batch,
        warehouse: row.warehouse,
        shipBatches: new Set(),
        inbounds: new Set(),
        scanable: 0,
        scanned: 0,
        bad: 0,
        manual: 0,
        blank: 0,
        missing: 0,
        rowsTotal: 0,
      });
    }
    const group = groups.get(key);
    group.rowsTotal += 1;
    if (row.shipBatch) group.shipBatches.add(row.shipBatch);
    if (isValidKey(normalizeKey(row.inbound))) group.inbounds.add(row.inbound);
    if (row.hasSn) group.scanable += 1;
    else group.blank += 1;
    if (row.hasSn && row.scanned) group.scanned += 1;
    if (row.hasSn && row.bad) group.bad += 1;
    if (row.hasSn && row.manual) group.manual += 1;
    if (row.hasSn && !row.scanned) group.missing += 1;
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      shipBatchLabel: [...group.shipBatches].slice(0, 3).join(" / "),
      inboundLabel: [...group.inbounds].slice(0, 3).join(" / "),
      progress: ratio(group.scanned, group.scanable),
    }))
    .sort((a, b) => b.missing - a.missing || b.scanable - a.scanable || a.batch.localeCompare(b.batch, "zh-CN"));
}

function computeWarehouseStats(rows) {
  const groups = new Map();

  for (const row of rows) {
    if (!groups.has(row.warehouse)) {
      groups.set(row.warehouse, { warehouse: row.warehouse, scanable: 0, scanned: 0, bad: 0, missing: 0 });
    }
    const group = groups.get(row.warehouse);
    if (row.hasSn) group.scanable += 1;
    if (row.hasSn && row.scanned) group.scanned += 1;
    if (row.hasSn && row.bad) group.bad += 1;
    if (row.hasSn && !row.scanned) group.missing += 1;
  }

  return [...groups.values()]
    .map((group) => ({ ...group, progress: ratio(group.scanned, group.scanable) }))
    .sort((a, b) => b.scanable - a.scanable || a.warehouse.localeCompare(b.warehouse, "zh-CN"));
}

function computeScanPeriodStats(model, filters) {
  const rowsBySn = new Map();
  for (const row of model.rows) {
    if (!row.snKey) continue;
    if (!rowsBySn.has(row.snKey)) rowsBySn.set(row.snKey, []);
    rowsBySn.get(row.snKey).push(row);
  }

  const groups = new Map();
  const search = normalizeSearch(filters.search);
  const inbound = normalizeSearch(filters.inbound);

  for (const event of model.scanEvents) {
    const matchedRows = event.snKey ? rowsBySn.get(event.snKey) || [] : [];
    if (!scanEventMatchesFilters(event, matchedRows, filters, search, inbound)) continue;

    const period = getScanPeriod(event.timestamp, state.scanPeriodMode);
    const warehouse = displayScanWarehouse(matchedRows);
    const sku = displayScanSku(matchedRows);
    const key = `${period.key}|||${warehouse}|||${sku}`;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        periodKey: period.key,
        periodLabel: period.label,
        periodStart: period.start,
        warehouse,
        sku,
        total: 0,
        good: 0,
        bad: 0,
        batches: new Set(),
      });
    }

    const group = groups.get(key);
    group.total += 1;
    if (event.bad) group.bad += 1;
    else group.good += 1;

    const batchLabels = getEventBatchLabels(matchedRows);
    batchLabels.forEach((batch) => group.batches.add(batch));
  }

  return [...groups.values()]
    .map((group) => {
      const batches = [...group.batches].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
      return {
        ...group,
        batches,
        batchLabel: formatBatchList(batches),
        badRate: ratio(group.bad, group.total),
      };
    })
    .sort((a, b) => {
      if (a.periodStart || b.periodStart) {
        if (!a.periodStart) return 1;
        if (!b.periodStart) return -1;
      if (a.periodStart !== b.periodStart) return b.periodStart - a.periodStart;
      }
      return (
        a.warehouse.localeCompare(b.warehouse, "zh-CN", { numeric: true }) ||
        a.sku.localeCompare(b.sku, "zh-CN", { numeric: true })
      );
    });
}

function scanEventMatchesFilters(event, matchedRows, filters, search, inbound) {
  if (filters.warehouse) {
    const selectedWarehouse = normalizeKey(filters.warehouse);
    const riskWarehouseMatched = matchedRows.some((row) => normalizeKey(row.warehouse) === selectedWarehouse);
    if (!riskWarehouseMatched) return false;
  }

  if (filters.batch && !matchedRows.some((row) => row.batch === filters.batch || row.shipBatch === filters.batch)) return false;
  if (inbound && !matchedRows.some((row) => normalizeSearch(row.inbound).includes(inbound))) return false;

  if (filters.status === "bad" && !event.bad) return false;
  if (filters.status === "duplicate" && matchedRows.every((row) => row.eventCount < 2)) return false;
  if (filters.status === "blank" && event.snKey) return false;
  if (filters.status === "noConfig" && matchedRows.some((row) => row.configMatched)) return false;
  if (filters.status === "manual") return false;
  if (filters.status === "missing") return false;

  if (search) {
    const haystack = normalizeSearch(
      [
        event.rawSn,
        event.warehouse,
        event.operator,
        event.time,
        ...matchedRows.flatMap((row) => [
          row.sn,
          row.machine,
          row.inbound,
          row.upstream,
          row.sku,
          row.itemName,
          row.batch,
          row.shipBatch,
          row.warehouse,
          row.destination,
        ]),
      ].join(" "),
    );
    if (!haystack.includes(search)) return false;
  }

  return true;
}

function displayScanWarehouse(matchedRows) {
  const warehouses = uniqueSorted(matchedRows.map((row) => row.warehouse));
  if (warehouses.length === 1) return warehouses[0];
  if (warehouses.length > 1) return warehouses.join(" / ");
  return "未匹配风险清单";
}

function displayScanSku(matchedRows) {
  const skus = uniqueSorted(matchedRows.map((row) => row.sku));
  if (skus.length === 1) return skus[0];
  if (skus.length > 1) return skus.join(" / ");
  return "未匹配SKU";
}

function getEventBatchLabels(matchedRows) {
  const labels = matchedRows.map((row) => clean(row.shipBatch || row.batch)).filter(Boolean);
  return labels.length ? labels : ["未匹配风险清单"];
}

function formatBatchList(batches) {
  if (!batches.length) return "-";
  const visible = batches.slice(0, 5).join(" / ");
  return batches.length > 5 ? `${visible} 等 ${nf.format(batches.length)} 个` : visible;
}

function getScanPeriod(timestamp, mode) {
  if (!timestamp) return { key: "unknown", label: "无时间", start: 0 };
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  if (mode === "hour") {
    return {
      key: `${year}-${month}-${day} ${hour}`,
      label: `${year}-${month}-${day} ${hour}:00`,
      start: new Date(year, date.getMonth(), date.getDate(), date.getHours()).getTime(),
    };
  }
  return {
    key: `${year}-${month}-${day}`,
    label: `${year}-${month}-${day}`,
    start: new Date(year, date.getMonth(), date.getDate()).getTime(),
  };
}

function renderKpis(stats) {
  setText("kpiRisk", nf.format(stats.scanable));
  setText("kpiRiskNote", `剔除空 SN · 共 ${nf.format(stats.rowsTotal)} 条风险记录`);
  setText("kpiScanEvents", nf.format(stats.totalEvents));
  setText("kpiScanEventsNote", stats.unmatchedEvents ? `未匹配风险 SN ${nf.format(stats.unmatchedEvents)}` : "全部扫码已匹配");
  setText("kpiScanned", nf.format(stats.scanned));
  setText("kpiProgress", `${formatPct(stats.progress)} 完成${stats.manual ? ` · 手动 ${nf.format(stats.manual)}` : ""}`);
  setText("kpiMissing", nf.format(stats.missing));
  setText("kpiMissingRate", `${formatPct(stats.missingRate)} 剩余`);
}

function renderBatchList(groups) {
  $("batchSummary").textContent = `${nf.format(groups.length)} 个批次/仓库组合`;
  const container = $("batchList");

  if (!groups.length) {
    container.innerHTML = `<div class="empty-state">暂无匹配的批次 / 仓库组合</div>`;
    return;
  }

  container.innerHTML = groups
    .slice(0, 140)
    .map((group) => {
      const fillClass = group.progress < 0.5 ? "bad" : group.progress < 0.9 ? "warn" : "";
      return `
        <div class="batch-row">
          <div class="batch-title" title="${escapeAttr(group.batch)}">
            <strong>${escapeHtml(group.batch)}</strong>
            <span>${escapeHtml(group.shipBatchLabel || "无发货批次")}</span>
          </div>
          <div class="batch-title" title="${escapeAttr(group.warehouse)}">
            <strong>${escapeHtml(group.warehouse)}</strong>
            <span>${escapeHtml(group.inboundLabel || "无有效入库单")}</span>
          </div>
          <div class="progress-block">
            <div class="progress-track">
              <div class="progress-fill ${fillClass}" style="width:${Math.min(group.progress * 100, 100)}%"></div>
            </div>
            <span class="cell-muted">${formatPct(group.progress)} 完成</span>
          </div>
          ${metricCell(group.scanable, "风险")}
          ${metricCell(group.scanned, "已扫")}
          ${metricCell(group.bad, "不良")}
          ${metricCell(group.missing, "遗漏")}
          <button class="row-action" type="button" data-batch="${escapeAttr(group.batch)}" data-warehouse="${escapeAttr(group.warehouse)}">
            <i data-lucide="filter"></i>
            <span>筛选</span>
          </button>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".row-action").forEach((button) => {
    button.addEventListener("click", () => {
      state.filters.batch = button.dataset.batch || "";
      state.filters.warehouse = button.dataset.warehouse || "";
      syncFilterInputs();
      renderFromModel();
    });
  });
}

function renderWarehouseChart(groups) {
  $("warehouseSummary").textContent = `${nf.format(groups.length)} 个仓库`;
  const container = $("warehouseChart");

  if (!groups.length) {
    container.innerHTML = `<div class="empty-state">暂无仓库数据</div>`;
    return;
  }

  container.innerHTML = groups
    .map((group) => {
      const scannedWidth = Math.min(group.progress * 100, 100);
      const badWidth = Math.min(ratio(group.bad, group.scanable) * 100, scannedWidth);
      return `
        <button class="warehouse-bar" type="button" data-warehouse="${escapeAttr(group.warehouse)}">
          <div class="warehouse-bar-top">
            <strong>${escapeHtml(group.warehouse)}</strong>
            <span>${nf.format(group.scanned)} / ${nf.format(group.scanable)}</span>
          </div>
          <div class="bar-stack" aria-hidden="true">
            <span class="bar-scanned" style="width:${scannedWidth}%"></span>
            <span class="bar-bad" style="width:${badWidth}%"></span>
          </div>
          <div class="warehouse-bar-top">
            <span>${formatPct(group.progress)}</span>
            <span>遗漏 ${nf.format(group.missing)} · 不良 ${nf.format(group.bad)}</span>
          </div>
        </button>
      `;
    })
    .join("");

  container.querySelectorAll(".warehouse-bar").forEach((button) => {
    button.addEventListener("click", () => {
      state.filters.warehouse = button.dataset.warehouse || "";
      syncFilterInputs();
      renderFromModel();
    });
  });
}

function renderScanPeriodBoard(groups) {
  document.querySelectorAll("[data-scan-period]").forEach((button) => {
    button.classList.toggle("active", button.dataset.scanPeriod === state.scanPeriodMode);
  });

  const visibleRows = groups.slice(0, 240);
  const totalEvents = groups.reduce((sum, group) => sum + group.total, 0);
  const warehouses = new Set(groups.map((group) => group.warehouse)).size;
  const skus = new Set(groups.map((group) => group.sku)).size;
  $("scanPeriodSummary").textContent =
    `${state.scanPeriodMode === "hour" ? "按小时" : "按日"} · ${nf.format(groups.length)} 个时间/仓/SKU组合 · ${nf.format(warehouses)} 个仓 · ${nf.format(skus)} 个SKU · ${nf.format(totalEvents)} 条扫码`;

  const tbody = $("scanPeriodTableBody");
  if (!visibleRows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">暂无扫码上报数据</td></tr>`;
    return;
  }

  tbody.innerHTML = visibleRows
    .map(
      (group) => `
        <tr>
          <td class="mono">${escapeHtml(group.periodLabel)}</td>
          <td><span class="truncate" title="${escapeAttr(group.warehouse)}">${escapeHtml(group.warehouse)}</span></td>
          <td class="mono"><span class="truncate" title="${escapeAttr(group.sku)}">${escapeHtml(group.sku)}</span></td>
          <td><strong>${nf.format(group.total)}</strong></td>
          <td>${nf.format(group.good)}</td>
          <td>${nf.format(group.bad)}</td>
          <td>${formatPct(group.badRate)}</td>
          <td><span class="truncate" title="${escapeAttr(group.batches.join(" / "))}">${escapeHtml(group.batchLabel)}</span></td>
        </tr>
      `,
    )
    .join("");
}

function renderRiskTable(rows) {
  const sorted = [...rows].sort(sortRiskRows);
  const visibleRows = sorted.slice(0, MAX_TABLE_ROWS);
  $("tableSummary").textContent =
    `${nf.format(rows.length)} 条匹配记录，当前显示 ${nf.format(visibleRows.length)} 条`;

  const tbody = $("riskTableBody");
  if (!visibleRows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">暂无明细</td></tr>`;
    return;
  }

  tbody.innerHTML = visibleRows.map(renderRiskRow).join("");
}

function renderRiskRow(row) {
  const status = getRiskStatus(row);
  const latest = row.latestEvent;

  return `
    <tr>
      <td>${statusBadge(status)}</td>
      <td class="mono"><span class="truncate" title="${escapeAttr(row.sn || "空 SN")}">${escapeHtml(row.sn || "空 SN")}</span></td>
      <td><span class="truncate" title="${escapeAttr(row.warehouse)}">${escapeHtml(row.warehouse)}</span></td>
      <td>
        <span class="truncate" title="${escapeAttr(row.batch)}">${escapeHtml(row.batch)}</span>
        <span class="cell-muted">${escapeHtml(row.shipBatch || "")}</span>
      </td>
      <td class="mono"><span class="truncate" title="${escapeAttr(row.inbound)}">${escapeHtml(row.inbound || "-")}</span></td>
      <td class="mono"><span class="truncate" title="${escapeAttr(row.sku)}">${escapeHtml(row.sku || "-")}</span></td>
      <td><span class="truncate" title="${escapeAttr(latest?.time || "")}">${escapeHtml(latest?.time || "-")}</span></td>
      <td><span class="truncate" title="${escapeAttr(latest?.warehouse || "")}">${escapeHtml(latest?.warehouse || "-")}</span></td>
      <td>${row.manual ? "手动" : row.eventCount ? nf.format(row.eventCount) : "-"}</td>
    </tr>
  `;
}

function renderExceptions(stats, model) {
  const issues = [];

  if (model.scanEvents.length === 0) {
    issues.push({
      level: "info",
      title: "前端 key 可见 scan_events 为 0 条",
      detail: "如果 Supabase Studio 里有记录，请检查 scan_events 的 RLS / select policy；当前网页不会把不可见记录计入进度。",
      count: 0,
    });
  }

  if (model.scanEvents.length > 0 && !model.scanFields.sn) {
    issues.push({
      level: "bad",
      title: "未识别扫码 SN 字段",
      detail: `scan_events 字段：${model.scanFields.keys.join(" / ") || "无字段"}`,
      count: model.scanEvents.length,
    });
  }

  if (stats.unmatchedEvents > 0) {
    const examples = model.unmatchedEvents
      .slice(0, 4)
      .map((event) => event.rawSn)
      .join(" / ");
    issues.push({
      level: "warn",
      title: "扫码记录未匹配风险 SN",
      detail: examples || "这些扫码不会进入分拣进度。",
      count: stats.unmatchedEvents,
    });
  }

  if (model.staticManualSummary.configured > 0) {
    const unmatchedRules = model.staticManualSummary.items.filter((item) => item.matched === 0 && !item.skippedByScanEvents).length;
    const scanPriorityRules = model.staticManualSummary.items.filter((item) => item.skippedByScanEvents).length;
    const scanPriorityDetail = scanPriorityRules
      ? `，${nf.format(scanPriorityRules)} 条规则因 ${nf.format(model.staticManualSummary.scanEventPriorityBatches)} 个批次已命中 scan_events 而按云端优先`
      : "";
    issues.push({
      level: unmatchedRules ? "warn" : "info",
      title: "文件手动标记已加载",
      detail: `${nf.format(model.staticManualSummary.configured)} 条规则，补标 ${nf.format(model.staticManualAppliedRows)} 个风险 SN${unmatchedRules ? `，${nf.format(unmatchedRules)} 条规则未匹配` : ""}${scanPriorityDetail}。`,
      count: model.staticManualAppliedRows,
    });
  }

  if (model.localManualAppliedRows > 0) {
    issues.push({
      level: "info",
      title: "手动配置已计入进度",
      detail: `本地补录 ${nf.format(model.manualSummary.configured)} 条配置，已补标 ${nf.format(model.localManualAppliedRows)} 个 SN。`,
      count: model.localManualAppliedRows,
    });
  }

  if (stats.duplicate > 0) {
    issues.push({
      level: "info",
      title: "同一 SN 有重复扫码",
      detail: "进度按唯一 SN 计数，不会重复累加。",
      count: stats.duplicate,
    });
  }

  const noRiskTransfers = getVisibleNoRiskTransfers(model);
  if (noRiskTransfers.count > 0) {
    issues.push({
      level: "info",
      title: "无风险调拨批次",
      detail: `这些调拨单当前没有命中风险 SN：${noRiskTransfers.examples.join(" / ")}`,
      count: noRiskTransfers.count,
    });
  }

  $("exceptionSummary").textContent = `${nf.format(issues.length)} 项`;
  const container = $("exceptionList");
  if (!issues.length) {
    container.innerHTML = `<div class="empty-state">暂无异常</div>`;
    return;
  }

  container.innerHTML = issues
    .map(
      (issue) => `
      <div class="exception-item">
        ${statusBadge({ tone: issue.level, label: issue.level === "bad" ? "高" : issue.level === "warn" ? "中" : "提示" })}
        <div class="exception-copy">
          <strong>${escapeHtml(issue.title)}</strong>
          <span>${escapeHtml(issue.detail)}</span>
        </div>
        <strong>${nf.format(issue.count)}</strong>
      </div>
    `,
    )
    .join("");
}

function getVisibleNoRiskTransfers(model) {
  const noRiskSet = new Set(model.configOnlyInbounds);
  const search = normalizeSearch(state.filters.search);
  const inboundFilter = normalizeSearch(state.filters.inbound);
  const rows = state.warehouseRows.filter((row) => {
    const inbound = clean(row[FIELDS.warehouse.inbound]);
    if (!noRiskSet.has(normalizeKey(inbound))) return false;
    if (state.filters.warehouse && clean(row[FIELDS.warehouse.warehouse]) !== state.filters.warehouse) return false;
    if (state.filters.batch && clean(row[FIELDS.warehouse.batch]) !== state.filters.batch) return false;
    if (inboundFilter && !normalizeSearch(inbound).includes(inboundFilter)) return false;
    if (search) {
      const haystack = normalizeSearch(
        [
          inbound,
          row[FIELDS.warehouse.batch],
          row[FIELDS.warehouse.shipBatch],
          row[FIELDS.warehouse.warehouse],
          row[FIELDS.warehouse.sku],
          row[FIELDS.warehouse.upstream],
        ].join(" "),
      );
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
  const inbounds = uniqueSorted(rows.map((row) => row[FIELDS.warehouse.inbound])).filter(isDisplayableInbound);
  return {
    count: inbounds.length,
    examples: inbounds.slice(0, 5),
  };
}

function isDisplayableInbound(value) {
  const normalized = normalizeKey(value);
  return isValidKey(normalized) && !/^\/+$/.test(normalized);
}

function renderHeader(stats) {
  const loadedAt = state.model?.loadedAt;
  const footprint = [
    `调拨 ${nf.format(state.warehouseRows.length)}`,
    `风险 ${nf.format(state.riskRows.length)}`,
    `扫码 ${nf.format(state.model?.scanEvents.length || 0)}`,
    state.model?.excludedTestScanRows ? `排除测试 ${nf.format(state.model.excludedTestScanRows)}` : "",
    state.model?.staticManualAppliedRows ? `文件标记 ${nf.format(state.model.staticManualAppliedRows)}` : "",
    state.model?.localManualAppliedRows ? `手动补录 ${nf.format(state.model.localManualAppliedRows)}` : "",
  ].filter(Boolean).join(" · ");

  $("lastUpdated").textContent = loadedAt ? `更新 ${loadedAt.toLocaleString("zh-CN")}` : "等待数据";
  $("dataFootprint").textContent = footprint;

  const active = [];
  if (state.filters.warehouse) active.push(state.filters.warehouse);
  if (state.filters.batch) active.push(state.filters.batch);
  if (state.filters.inbound) active.push(`入库单 ${state.filters.inbound}`);
  if (state.filters.status) active.push($("statusFilter").selectedOptions[0]?.textContent || state.filters.status);
  if (state.filters.search) active.push(`搜索 ${state.filters.search}`);
  $("activeFilterBadge").textContent = active.length ? active.join(" / ") : "全部数据";

  document.title = `风险 SN 分拣看板 · ${nf.format(stats.missing)} 未分拣`;
}

function updateFilterOptions() {
  if (!state.model) return;
  const rows = state.model.rows;
  setSelectOptions("warehouseFilter", uniqueSorted(rows.map((row) => row.warehouse)), "全部仓库");
  setSelectOptions("batchFilter", uniqueSorted(rows.map((row) => row.batch)), "全部批次");

  $("inboundOptions").innerHTML = uniqueSorted(rows.map((row) => row.inbound).filter((value) => isValidKey(normalizeKey(value))))
    .map((value) => `<option value="${escapeAttr(value)}"></option>`)
    .join("");

  syncFilterInputs();
  updateManualOptions();
}

function setSelectOptions(id, values, allLabel) {
  const select = $(id);
  const current = select.value;
  select.innerHTML = [`<option value="">${escapeHtml(allLabel)}</option>`]
    .concat(values.map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`))
    .join("");
  select.value = values.includes(current) ? current : "";
  state.filters[id === "warehouseFilter" ? "warehouse" : "batch"] = select.value;
}

function resetFilters() {
  state.filters = { warehouse: "", batch: "", inbound: "", status: "", search: "" };
  syncFilterInputs();
  renderFromModel();
}

function syncFilterInputs() {
  $("warehouseFilter").value = state.filters.warehouse;
  $("batchFilter").value = state.filters.batch;
  $("inboundFilter").value = state.filters.inbound;
  $("statusFilter").value = state.filters.status;
  $("searchFilter").value = state.filters.search;
}

function exportFilteredCsv() {
  if (!state.filteredRows?.length) {
    showToast("当前没有可导出的明细");
    return;
  }

  const header = ["状态", "风险SN", "仓库", "批次", "发货批次", "入库单", "上游出库单", "SKU", "扫码时间", "扫码仓", "扫码次数", "来源", "匹配方式"];
  const body = state.filteredRows.map((row) => [
    getRiskStatus(row).label,
    row.sn,
    row.warehouse,
    row.batch,
    row.shipBatch,
    row.inbound,
    row.upstream,
    row.sku,
    row.latestEvent?.time || "",
    row.latestEvent?.warehouse || "",
    row.eventCount,
    getRowSourceLabel(row),
    row.configMatchMode,
  ]);
  const csv = [header, ...body].map((line) => line.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `risk-sn-progress-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function openManualModal() {
  $("manualModal").classList.add("show");
  $("manualModal").setAttribute("aria-hidden", "false");
  renderManualAuthState();
  updateManualOptions();
  renderManualPanel();
  if (state.manualAuthenticated) {
    $("manualWarehouseInput").focus();
  } else {
    $("manualPasswordInput").focus();
  }
}

function closeManualModal() {
  $("manualModal").classList.remove("show");
  $("manualModal").setAttribute("aria-hidden", "true");
}

async function handleManualLogin(event) {
  event.preventDefault();
  const password = $("manualPasswordInput").value;
  const ok = await verifyManualPassword(password);
  if (!ok) {
    showToast("密码不正确");
    return;
  }

  state.manualAuthenticated = true;
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, "authenticated");
  $("manualPasswordInput").value = "";
  renderManualAuthState();
  updateManualOptions();
  showToast("已登录手动配置");
}

function logoutManualConfig() {
  state.manualAuthenticated = false;
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  state.editingManualId = "";
  resetManualForm();
  renderManualAuthState();
  showToast("已退出手动配置");
}

async function verifyManualPassword(password) {
  const config = await loadPasswordConfig();
  const hash = await sha256Hex(password || "");
  return hash === (config.passwordHash || DEFAULT_PASSWORD_HASH);
}

async function loadPasswordConfig() {
  if (state.passwordConfig) return state.passwordConfig;
  try {
    const response = await fetch(PASSWORD_CONFIG_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("password config missing");
    state.passwordConfig = await response.json();
  } catch (error) {
    state.passwordConfig = {
      passwordHash: DEFAULT_PASSWORD_HASH,
      passwordHashAlgorithm: "SHA-256",
      passwordHint: "admin123",
    };
  }
  return state.passwordConfig;
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function renderManualAuthState() {
  $("manualLoginForm").hidden = state.manualAuthenticated;
  $("manualConfigPanel").hidden = !state.manualAuthenticated;
  $("manualAuthState").textContent = state.manualAuthenticated ? "已登录" : "未登录";
}

function updateManualOptions() {
  if (!state.model) return;
  const warehouseSelect = $("manualWarehouseInput");
  const current = warehouseSelect.value || state.filters.warehouse;
  const warehouses = uniqueSorted(state.model.rows.map((row) => row.warehouse));
  warehouseSelect.innerHTML = warehouses
    .map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`)
    .join("");
  warehouseSelect.value = warehouses.includes(current) ? current : warehouses[0] || "";
  updateManualBatchOptions();
}

function updateManualBatchOptions() {
  if (!state.model) return;
  const warehouse = $("manualWarehouseInput").value;
  const batchSelect = $("manualBatchInput");
  const current = batchSelect.value || state.filters.batch;
  const batches = uniqueSorted(
    state.model.rows
      .filter((row) => !warehouse || row.warehouse === warehouse)
      .map((row) => row.batch),
  );
  batchSelect.innerHTML = batches
    .map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`)
    .join("");
  batchSelect.value = batches.includes(current) ? current : batches[0] || "";
}

function handleManualOverrideSave(event) {
  event.preventDefault();
  if (!state.manualAuthenticated) return;

  const warehouse = $("manualWarehouseInput").value;
  const batch = $("manualBatchInput").value;
  const badCount = Math.max(0, Math.floor(Number($("manualBadCountInput").value) || 0));
  const note = $("manualNoteInput").value.trim();

  if (!warehouse || !batch) {
    showToast("请选择仓库和批次");
    return;
  }

  const existingIndex = state.manualOverrides.findIndex(
    (item) => item.id === state.editingManualId || (item.warehouse === warehouse && item.batch === batch),
  );
  const now = new Date().toISOString();
  const item = {
    id: existingIndex >= 0 ? state.manualOverrides[existingIndex].id : `manual-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    warehouse,
    batch,
    badCount,
    note,
    updatedAt: now,
  };

  if (existingIndex >= 0) state.manualOverrides.splice(existingIndex, 1, item);
  else state.manualOverrides.push(item);

  saveManualOverrides();
  state.editingManualId = "";
  resetManualForm();
  rebuildAndRender();
  showToast("手动配置已保存");
}

function handleManualListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button || !state.manualAuthenticated) return;

  const item = state.manualOverrides.find((override) => override.id === button.dataset.id);
  if (!item) return;

  if (button.dataset.action === "edit") {
    state.editingManualId = item.id;
    $("manualWarehouseInput").value = item.warehouse;
    updateManualBatchOptions();
    $("manualBatchInput").value = item.batch;
    $("manualBadCountInput").value = item.badCount;
    $("manualNoteInput").value = item.note || "";
    $("manualBadCountInput").focus();
    return;
  }

  if (button.dataset.action === "delete") {
    state.manualOverrides = state.manualOverrides.filter((override) => override.id !== item.id);
    saveManualOverrides();
    if (state.editingManualId === item.id) resetManualForm();
    rebuildAndRender();
    showToast("手动配置已删除");
    return;
  }

  if (button.dataset.action === "filter") {
    state.filters.warehouse = item.warehouse;
    state.filters.batch = item.batch;
    state.filters.status = "manual";
    syncFilterInputs();
    renderFromModel();
    closeManualModal();
  }
}

function resetManualForm() {
  state.editingManualId = "";
  $("manualBadCountInput").value = "";
  $("manualNoteInput").value = "";
  updateManualOptions();
}

function renderManualPanel() {
  renderManualAuthState();
  if (!state.manualAuthenticated) return;
  renderManualOverrideList();
}

function renderManualOverrideList() {
  const list = $("manualOverrideList");
  const summaryById = new Map((state.model?.manualSummary.items || []).map((item) => [item.id, item]));
  $("manualOverrideSummary").textContent = `${nf.format(state.manualOverrides.length)} 条`;

  if (!state.manualOverrides.length) {
    list.innerHTML = `<div class="empty-state">暂无手动配置</div>`;
    return;
  }

  list.innerHTML = state.manualOverrides
    .map((item) => {
      const summary = summaryById.get(item.id);
      const applied = summary ? summary.applied : 0;
      const cloudBad = summary ? summary.cloudBadCount : 0;
      const shortage = summary ? summary.shortage : 0;
      return `
        <div class="manual-item">
          <div class="manual-item-main">
            <strong>${escapeHtml(item.warehouse)} / ${escapeHtml(item.batch)}</strong>
            <span>目标不良 ${nf.format(item.badCount)} · 云端不良 ${nf.format(cloudBad)} · 手动补标 ${nf.format(applied)}${shortage ? ` · 不足 ${nf.format(shortage)}` : ""}</span>
            ${item.note ? `<span>${escapeHtml(item.note)}</span>` : ""}
          </div>
          <div class="manual-item-actions">
            <button class="icon-button" type="button" data-action="filter" data-id="${escapeAttr(item.id)}" aria-label="筛选">
              <i data-lucide="filter"></i>
            </button>
            <button class="icon-button" type="button" data-action="edit" data-id="${escapeAttr(item.id)}" aria-label="编辑">
              <i data-lucide="pencil"></i>
            </button>
            <button class="icon-button danger" type="button" data-action="delete" data-id="${escapeAttr(item.id)}" aria-label="删除">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

function rebuildAndRender() {
  if (state.riskRows.length) {
    state.model = buildModel();
    renderFromModel();
  }
}

function loadManualOverrides() {
  try {
    const raw = window.localStorage.getItem(MANUAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeManualOverride).filter(Boolean);
  } catch (error) {
    return [];
  }
}

function saveManualOverrides() {
  window.localStorage.setItem(MANUAL_STORAGE_KEY, JSON.stringify(state.manualOverrides));
}

function normalizeManualOverride(item) {
  if (!item || typeof item !== "object") return null;
  const warehouse = clean(item.warehouse);
  const batch = clean(item.batch);
  if (!warehouse || !batch) return null;
  return {
    id: clean(item.id) || `manual-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    warehouse,
    batch,
    badCount: Math.max(0, Math.floor(Number(item.badCount) || 0)),
    note: clean(item.note),
    updatedAt: clean(item.updatedAt) || new Date().toISOString(),
  };
}

function exportManualOverrides() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    overrides: state.manualOverrides,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `manual-sort-overrides-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function importManualOverrides(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const parsed = JSON.parse(String(reader.result || "{}"));
      const rawItems = Array.isArray(parsed) ? parsed : parsed.overrides;
      if (!Array.isArray(rawItems)) throw new Error("invalid manual override file");
      state.manualOverrides = rawItems.map(normalizeManualOverride).filter(Boolean);
      saveManualOverrides();
      resetManualForm();
      rebuildAndRender();
      showToast("手动配置已导入");
    } catch (error) {
      showToast("导入失败，文件格式不正确");
    }
  });
  reader.readAsText(file, "utf-8");
}

function getRowSourceLabel(row) {
  if (row.manualSource === "file") return "文件手动标记";
  if (row.manualSource === "local") return "网页手动配置";
  return row.eventCount ? "云端扫码" : "";
}

function getRiskStatus(row) {
  if (!row.hasSn) return { label: "空 SN", tone: "warn", rank: 1 };
  if (row.manual) return { label: row.manualSource === "file" ? "手动标记" : "手动配置", tone: "info", rank: 2 };
  if (row.scanned && row.bad) return { label: "不良", tone: "bad", rank: 2 };
  if (row.scanned) return { label: "已扫", tone: "good", rank: 4 };
  return { label: "未扫", tone: "warn", rank: 3 };
}

function sortRiskRows(a, b) {
  const aRecentTs = getRecentScanTimestamp(a);
  const bRecentTs = getRecentScanTimestamp(b);

  if (aRecentTs || bRecentTs) {
    if (!aRecentTs) return 1;
    if (!bRecentTs) return -1;
    if (a.warehouse !== b.warehouse) return a.warehouse.localeCompare(b.warehouse, "zh-CN", { numeric: true });
    if (aRecentTs !== bRecentTs) return bRecentTs - aRecentTs;
    return compareShipBatch(a, b) || (a.sn || "").localeCompare(b.sn || "", "zh-CN", { numeric: true });
  }

  const shipBatchDiff = compareShipBatch(a, b);
  if (shipBatchDiff) return shipBatchDiff;
  if (a.warehouse !== b.warehouse) return a.warehouse.localeCompare(b.warehouse, "zh-CN", { numeric: true });
  const statusDiff = getRiskStatus(a).rank - getRiskStatus(b).rank;
  if (statusDiff) return statusDiff;
  return (a.sn || "").localeCompare(b.sn || "", "zh-CN");
}

function getRecentScanTimestamp(row) {
  if (row.manual) return 0;
  const timestamp = Number(row.latestEvent?.timestamp || 0);
  if (!timestamp) return 0;
  const age = Date.now() - timestamp;
  return age >= 0 && age <= RECENT_SCAN_WINDOW_MS ? timestamp : 0;
}

function compareShipBatch(a, b) {
  const left = clean(a.shipBatch || a.batch);
  const right = clean(b.shipBatch || b.batch);
  if (left !== right) return left.localeCompare(right, "zh-CN", { numeric: true });
  if (a.batch !== b.batch) return a.batch.localeCompare(b.batch, "zh-CN", { numeric: true });
  return 0;
}

function statusBadge(status) {
  return `<span class="badge ${status.tone}">${escapeHtml(status.label)}</span>`;
}

function metricCell(value, label) {
  return `
    <div class="metric">
      <strong>${nf.format(value)}</strong>
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}

function pushToMap(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function getAllKeys(rows) {
  const keys = new Set();
  rows.slice(0, 200).forEach((row) => Object.keys(row || {}).forEach((key) => keys.add(key)));
  return [...keys];
}

function pickExisting(keys, candidates) {
  const lowerKeyMap = new Map(keys.map((key) => [key.toLowerCase(), key]));
  for (const candidate of candidates) {
    if (keys.includes(candidate)) return candidate;
    const lower = lowerKeyMap.get(candidate.toLowerCase());
    if (lower) return lower;
  }
  return "";
}

function compareEventsAscending(a, b) {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.index - b.index;
}

function parseTimestamp(value) {
  if (!value) return 0;
  const direct = new Date(value).getTime();
  if (Number.isFinite(direct)) return direct;
  const normalized = new Date(String(value).replace(/\//g, "-")).getTime();
  return Number.isFinite(normalized) ? normalized : 0;
}

function compositeKey(upstream, sku) {
  const left = normalizeKey(upstream);
  const right = normalizeKey(sku);
  if (!isValidKey(left) || !isValidKey(right)) return "";
  return `${left}|||${right}`;
}

function normalizeSn(value) {
  return clean(value).replace(/\s+/g, "").toUpperCase();
}

function normalizeKey(value) {
  return clean(value).toUpperCase();
}

function normalizeSearch(value) {
  return clean(value).toUpperCase();
}

function isValidKey(value) {
  return !INVALID_KEYS.has(normalizeKey(value));
}

function clean(value) {
  return String(value ?? "").trim();
}

function displayValue(value, fallback) {
  const normalized = normalizeKey(value);
  if (!isValidKey(normalized)) return fallback;
  return clean(value);
}

function ratio(num, den) {
  return den ? num / den : 0;
}

function formatPct(value) {
  return `${pctf.format(value * 100)}%`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function uniqueSorted(values) {
  return [...new Set(values.map(clean).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function setText(id, value) {
  $(id).textContent = value;
}

function setConnection(text, tone) {
  const badge = $("connectionBadge");
  badge.textContent = text;
  badge.className = `badge ${tone || "neutral"}`;
}

function setLoading(loading) {
  $("refreshBtn").disabled = loading;
  $("refreshBtn").querySelector("span").textContent = loading ? "刷新中" : "刷新";
}

function showFatal(message) {
  setConnection("初始化失败", "bad");
  $("batchList").innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
  $("scanPeriodTableBody").innerHTML = `<tr><td colspan="8" class="empty-state">${escapeHtml(message)}</td></tr>`;
  showToast(message);
}

function renderErrors(error) {
  const message = escapeHtml(error?.message || "数据读取失败");
  $("batchList").innerHTML = `<div class="empty-state">${message}</div>`;
  $("warehouseChart").innerHTML = `<div class="empty-state">${message}</div>`;
  $("scanPeriodTableBody").innerHTML = `<tr><td colspan="8" class="empty-state">${message}</td></tr>`;
  $("riskTableBody").innerHTML = `<tr><td colspan="9" class="empty-state">${message}</td></tr>`;
  $("exceptionList").innerHTML = `<div class="empty-state">${message}</div>`;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function renderIcons() {
  if (window.lucide?.createIcons) {
    window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
