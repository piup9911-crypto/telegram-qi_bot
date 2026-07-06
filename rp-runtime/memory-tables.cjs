const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_TEMPLATES = [
  {
    id: "space_time",
    name: "时空表格",
    description: "记录时空信息的表格，应保持在一行",
    columns: ["日期", "时间", "地点（当前描写）", "此地角色"],
    required: true,
    asStatus: true,
    toChat: true,
    note: "记录时空信息的表格，应保持在一行",
    initNode: "本轮需要记录当前时间、地点、人物信息，使用insertRow函数",
    insertNode: "",
    updateNode: "当描写的场景，时间，人物变更时",
    deleteNode: "此表大于一行时应删除多余行",
    inject: true
  },
  {
    id: "character_traits",
    name: "角色特征表格",
    description: "角色天生或不易改变的特征csv表格，思考本轮有否有其中的角色，他应作出什么反应",
    columns: ["角色名", "身体特征", "性格", "职业", "爱好", "喜欢的事物（作品、虚拟人物、物品等）", "住所", "其他重要信息"],
    required: true,
    asStatus: true,
    toChat: true,
    note: "角色天生或不易改变的特征csv表格，思考本轮有否有其中的角色，他应作出什么反应",
    initNode: "本轮必须从上文寻找已知的所有角色使用insertRow插入，角色名不能为空",
    insertNode: "当本轮出现表中没有的新角色时，应插入",
    updateNode: "当角色的身体出现持久性变化时，例如伤痕/当角色有新的爱好，职业，喜欢的事物时/当角色更换住所时/当角色提到重要信息时",
    deleteNode: "",
    inject: true
  },
  {
    id: "relationship",
    name: "角色与<user>社交表格",
    description: "思考如果有角色和<user>互动，应什么态度",
    columns: ["角色名", "对<user>关系", "对<user>态度", "对<user>好感"],
    required: true,
    asStatus: true,
    toChat: true,
    note: "思考如果有角色和<user>互动，应什么态度",
    initNode: "本轮必须从上文寻找已知的所有角色使用insertRow插入，角色名不能为空",
    insertNode: "当本轮出现表中没有的新角色时，应插入",
    updateNode: "当角色和<user>的交互不再符合原有的记录时/当角色和<user>的关系改变时",
    deleteNode: "",
    inject: true
  },
  {
    id: "tasks",
    name: "任务、命令或者约定表格",
    description: "思考本轮是否应该执行任务/赴约",
    columns: ["角色", "任务", "地点", "持续时间"],
    required: false,
    asStatus: true,
    toChat: true,
    note: "思考本轮是否应该执行任务/赴约",
    initNode: "",
    insertNode: "当特定时间约定一起去做某事时/某角色收到做某事的命令或任务时",
    updateNode: "",
    deleteNode: "当大家赴约时/任务或命令完成时/任务，命令或约定被取消时",
    inject: true
  },
  {
    id: "events",
    name: "重要事件历史表格",
    description: "记录<user>或角色经历的重要事件",
    columns: ["角色", "事件简述", "日期", "地点", "情绪"],
    required: true,
    asStatus: true,
    toChat: true,
    note: "记录<user>或角色经历的重要事件",
    initNode: "本轮必须从上文寻找可以插入的事件并使用insertRow插入",
    insertNode: "当某个角色经历让自己印象深刻的事件时，比如表白、分手等",
    updateNode: "",
    deleteNode: "",
    inject: true
  },
  {
    id: "items",
    name: "重要物品表格",
    description: "对某人很贵重或有特殊纪念意义的物品",
    columns: ["拥有人", "物品描述", "物品名", "重要原因"],
    required: false,
    asStatus: true,
    toChat: true,
    note: "对某人很贵重或有特殊纪念意义的物品",
    initNode: "",
    insertNode: "当某人获得了贵重或有特殊意义的物品时/当某个已有物品有了特殊意义时",
    updateNode: "",
    deleteNode: "",
    inject: true
  }
];

const COLUMN_ALIASES = {
  "地点（当前描写）": ["地点"],
  "喜欢的事物（作品、虚拟人物、物品等）": ["喜欢的事物"],
  "对<user>关系": ["对用户关系"],
  "对<user>态度": ["对用户态度"],
  "对<user>好感": ["对用户好感"]
};

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function cleanString(value, max = 12000) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, max);
}

function safeChatId(chatId) {
  const value = cleanString(chatId, 120);
  if (!/^[0-9A-Za-z_-]+$/.test(value)) throw new Error("Invalid RP chat id.");
  return value.startsWith("telegram_rp_") ? value : `telegram_rp_${value}`;
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function normalizeCell(value) {
  return cleanString(value, 2000).replace(/\r?\n/g, " ");
}

function makeCell(tableId, value = "", type = "cell", coordUid = "") {
  return {
    uid: uid(`cell_${tableId}`),
    coordUid: coordUid || uid("coord"),
    type,
    status: "",
    data: { value: normalizeCell(value) },
    created_at: nowIso()
  };
}

function cellTypeForPosition(rowIndex, colIndex) {
  if (rowIndex === 0 && colIndex === 0) return "sheet_origin";
  if (rowIndex === 0) return "column_header";
  if (colIndex === 0) return "row_header";
  return "cell";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function looksCorruptText(value) {
  const text = cleanString(value, 2000);
  return !text || /^[?\s]+$/.test(text) || /�/.test(text);
}

function shouldRepairTemplateFields(table, template) {
  if (!template) return false;
  const columns = Array.isArray(table && table.columns) ? table.columns : [];
  return (
    looksCorruptText(table && table.name) ||
    looksCorruptText(table && table.description) ||
    !columns.length ||
    columns.length !== template.columns.length ||
    columns.some((column, index) => column !== template.columns[index]) ||
    columns.some((column) => looksCorruptText(column))
  );
}

function tableFromTemplate(template) {
  return ensureSheetStructure({
    id: template.id,
    template_id: template.id,
    name: template.name,
    description: template.description || "",
    columns: [...template.columns],
    required: template.required !== false,
    asStatus: template.asStatus !== false,
    toChat: template.toChat !== false,
    note: template.note || "",
    initNode: template.initNode || "",
    insertNode: template.insertNode || "",
    updateNode: template.updateNode || "",
    deleteNode: template.deleteNode || "",
    enabled: true,
    inject: template.inject !== false,
    rows: [],
    updated_at: nowIso()
  });
}

function normalizeRow(row, columns) {
  const sourceCells = row && typeof row.cells === "object" ? row.cells : {};
  const cells = {};
  for (const column of columns) {
    const aliases = [column, ...(COLUMN_ALIASES[column] || [])];
    const sourceColumn = aliases.find((item) => Object.prototype.hasOwnProperty.call(sourceCells, item));
    cells[column] = normalizeCell(sourceColumn ? sourceCells[sourceColumn] : "");
  }
  return {
    id: cleanString(row && row.id, 80) || uid("row"),
    cells,
    source: cleanString(row && row.source, 80),
    confidence: Number.isFinite(Number(row && row.confidence)) ? Number(row.confidence) : null,
    created_at: cleanString(row && row.created_at, 80) || nowIso(),
    updated_at: cleanString(row && row.updated_at, 80) || nowIso(),
    history: Array.isArray(row && row.history) ? row.history.slice(-20) : []
  };
}

function rowsToValueSheet(rows, columns) {
  return [
    ["", ...columns],
    ...rows.map((row, index) => [String(index), ...columns.map((column) => row.cells[column] || "")])
  ];
}

function buildSheetFromRows(tableId, columns, rows) {
  const cellHistory = [];
  const hashSheet = rowsToValueSheet(rows, columns).map((line, rowIndex) => {
    return line.map((value, colIndex) => {
      const cell = makeCell(tableId, value, cellTypeForPosition(rowIndex, colIndex));
      cellHistory.push(cell);
      return cell.uid;
    });
  });
  return { cellHistory, hashSheet };
}

function findReusableCell(cells, usedUids, value, type) {
  return cells.find((cell) => {
    return (
      !usedUids.has(cell.uid) &&
      cell.type === type &&
      normalizeCell(cell.data && cell.data.value) === normalizeCell(value)
    );
  }) || null;
}

function cellMap(table) {
  return new Map((Array.isArray(table.cellHistory) ? table.cellHistory : []).map((cell) => [cell.uid, cell]));
}

function valueFromCell(map, uidValue) {
  const cell = map.get(uidValue);
  return cell && cell.data ? normalizeCell(cell.data.value) : "";
}

function rowsFromSheet(table) {
  const map = cellMap(table);
  const rows = [];
  const columns = table.columns || [];
  const oldRows = Array.isArray(table.rows) ? table.rows : [];
  for (let rowIndex = 1; rowIndex < (table.hashSheet || []).length; rowIndex += 1) {
    const line = table.hashSheet[rowIndex] || [];
    const oldRow = oldRows[rowIndex - 1] || {};
    const cells = {};
    for (let colIndex = 1; colIndex <= columns.length; colIndex += 1) {
      cells[columns[colIndex - 1]] = valueFromCell(map, line[colIndex]);
    }
    rows.push({
      id: cleanString(oldRow.id, 80) || uid("row"),
      cells,
      source: cleanString(oldRow.source, 80),
      confidence: Number.isFinite(Number(oldRow.confidence)) ? Number(oldRow.confidence) : null,
      created_at: cleanString(oldRow.created_at, 80) || nowIso(),
      updated_at: cleanString(oldRow.updated_at, 80) || nowIso(),
      history: Array.isArray(oldRow.history) ? oldRow.history.slice(-20) : [],
      cell_uids: Object.fromEntries(columns.map((column, index) => [column, line[index + 1] || ""]))
    });
  }
  return rows;
}

function ensureSheetStructure(table) {
  const rows = Array.isArray(table.rows) ? table.rows.map((row) => normalizeRow(row, table.columns || [])) : [];
  let cellHistory = Array.isArray(table.cellHistory) ? table.cellHistory : [];
  let hashSheet = Array.isArray(table.hashSheet) ? table.hashSheet : [];
  const expectedCols = (table.columns || []).length + 1;
  const hasUsableSheet =
    hashSheet.length > 0 &&
    hashSheet.every((line) => Array.isArray(line) && line.length === expectedCols) &&
    cellHistory.length > 0;
  if (!hasUsableSheet) {
    const sheet = buildSheetFromRows(table.id || uid("table"), table.columns || [], rows);
    cellHistory = sheet.cellHistory;
    hashSheet = sheet.hashSheet;
  }
  const next = {
    ...table,
    cellHistory: cellHistory.map((cell) => ({
      uid: cleanString(cell.uid, 120) || uid(`cell_${table.id}`),
      coordUid: cleanString(cell.coordUid, 120) || uid("coord"),
      type: cleanString(cell.type, 40) || "cell",
      status: cleanString(cell.status, 40),
      data: { value: normalizeCell(cell.data && cell.data.value) },
      created_at: cleanString(cell.created_at, 80) || nowIso()
    })),
    hashSheet: hashSheet.map((line) => line.map((item) => cleanString(item, 120)))
  };
  next.rows = rowsFromSheet(next);
  return next;
}

function refreshRowsFromSheet(table) {
  table.rows = rowsFromSheet(table);
  return table.rows;
}

function insertSheetRow(table, row) {
  const map = cellMap(table);
  const rowIndex = (table.hashSheet || []).length;
  const line = [];
  const rowHeader = makeCell(table.id, String(rowIndex - 1), "row_header");
  table.cellHistory.push(rowHeader);
  map.set(rowHeader.uid, rowHeader);
  line.push(rowHeader.uid);
  for (const column of table.columns || []) {
    const cell = makeCell(table.id, row.cells[column] || "", "cell");
    table.cellHistory.push(cell);
    map.set(cell.uid, cell);
    line.push(cell.uid);
  }
  table.hashSheet.push(line);
  const rows = refreshRowsFromSheet(table);
  const inserted = rows[rows.length - 1];
  if (inserted) {
    inserted.id = row.id;
    inserted.source = row.source;
    inserted.confidence = row.confidence;
    inserted.created_at = row.created_at;
    inserted.updated_at = row.updated_at;
    inserted.history = row.history || [];
  }
}

function updateSheetRow(table, rowId, patch, reason = "") {
  const rowIndex = (table.rows || []).findIndex((row) => row.id === rowId);
  if (rowIndex < 0) return false;
  const sheetRowIndex = rowIndex + 1;
  const line = table.hashSheet[sheetRowIndex];
  const map = cellMap(table);
  const row = table.rows[rowIndex];
  row.history = Array.isArray(row.history) ? row.history : [];
  row.history.push({ at: nowIso(), cells: { ...row.cells }, reason });
  row.history = row.history.slice(-20);
  for (const [colIndex, column] of (table.columns || []).entries()) {
    if (!Object.prototype.hasOwnProperty.call(patch, column)) continue;
    if (normalizeCell(patch[column]) === normalizeCell(row.cells && row.cells[column])) continue;
    const oldUid = line[colIndex + 1];
    const oldCell = map.get(oldUid);
    const nextCell = makeCell(table.id, patch[column], "cell", oldCell && oldCell.coordUid);
    table.cellHistory.push(nextCell);
    line[colIndex + 1] = nextCell.uid;
  }
  refreshRowsFromSheet(table);
  const refreshed = table.rows[rowIndex];
  if (refreshed) {
    refreshed.id = row.id;
    refreshed.source = row.source;
    refreshed.confidence = row.confidence;
    refreshed.created_at = row.created_at;
    refreshed.updated_at = nowIso();
    refreshed.history = row.history;
  }
  return true;
}

function deleteSheetRow(table, rowId) {
  const rowIndex = (table.rows || []).findIndex((row) => row.id === rowId);
  if (rowIndex < 0) return false;
  table.hashSheet.splice(rowIndex + 1, 1);
  table.deletedRows = Array.isArray(table.deletedRows) ? table.deletedRows : [];
  table.deletedRows.unshift({
    at: nowIso(),
    row: cloneJson(table.rows[rowIndex])
  });
  table.deletedRows = table.deletedRows.slice(0, 50);
  refreshRowsFromSheet(table);
  return true;
}

function rebuildSheetFromRows(table, rows) {
  const oldCells = Array.isArray(table.cellHistory) ? table.cellHistory : [];
  const oldHashSheet = Array.isArray(table.hashSheet) ? table.hashSheet : [];
  const oldCellMap = new Map(oldCells.map((cell) => [cell.uid, cell]));
  const oldRowsById = new Map((Array.isArray(table.rows) ? table.rows : []).map((row, index) => [row.id, index + 1]));
  const nextHistory = [...oldCells];
  const usedUids = new Set();
  const valueSheet = rowsToValueSheet(rows, table.columns || []);
  table.hashSheet = valueSheet.map((line, rowIndex) => {
    return line.map((value, colIndex) => {
      const type = cellTypeForPosition(rowIndex, colIndex);
      const sourceRow = rowIndex === 0 ? null : rows[rowIndex - 1];
      const oldRowIndex = rowIndex === 0 ? 0 : oldRowsById.get(sourceRow && sourceRow.id);
      const oldUid = oldHashSheet[oldRowIndex] && oldHashSheet[oldRowIndex][colIndex];
      const oldCell = oldCellMap.get(oldUid);
      if (oldCell && oldCell.type === type) {
        if (normalizeCell(oldCell.data && oldCell.data.value) === normalizeCell(value)) {
          usedUids.add(oldCell.uid);
          return oldCell.uid;
        }
        const cell = makeCell(table.id, value, type, oldCell.coordUid);
        nextHistory.push(cell);
        usedUids.add(cell.uid);
        return cell.uid;
      }
      const reusable = findReusableCell(oldCells, usedUids, value, type);
      if (reusable) {
        usedUids.add(reusable.uid);
        return reusable.uid;
      }
      const cell = makeCell(table.id, value, type);
      nextHistory.push(cell);
      usedUids.add(cell.uid);
      return cell.uid;
    });
  });
  table.cellHistory = nextHistory;
  const nextRows = refreshRowsFromSheet(table);
  nextRows.forEach((row, index) => {
    const source = rows[index] || {};
    row.id = cleanString(source.id, 80) || row.id;
    row.source = cleanString(source.source, 80);
    row.confidence = Number.isFinite(Number(source.confidence)) ? Number(source.confidence) : null;
    row.created_at = cleanString(source.created_at, 80) || row.created_at;
    row.updated_at = cleanString(source.updated_at, 80) || nowIso();
    row.history = Array.isArray(source.history) ? source.history.slice(-20) : [];
  });
}

function normalizeTable(table, template = null) {
  const repairTemplateFields = shouldRepairTemplateFields(table, template);
  const columns = !repairTemplateFields && Array.isArray(table && table.columns) && table.columns.length
    ? table.columns.map((item) => cleanString(item, 80)).filter(Boolean)
    : template
      ? [...template.columns]
      : [];
  const normalized = ensureSheetStructure({
    id: cleanString(table && table.id, 80) || (template && template.id) || uid("table"),
    template_id: cleanString(table && table.template_id, 80) || (template && template.id) || "",
    name: repairTemplateFields
      ? template.name
      : cleanString(table && table.name, 120) || (template && template.name) || "未命名表格",
    description: repairTemplateFields
      ? template.description || ""
      : cleanString(table && table.description, 500) || (template && template.description) || "",
    columns,
    required: template ? template.required !== false : table && table.required === true,
    asStatus: template ? template.asStatus !== false : table && table.asStatus !== false,
    toChat: template ? template.toChat !== false : table && table.toChat !== false,
    note: repairTemplateFields
      ? template.note || ""
      : cleanString(table && table.note, 500) || (template && template.note) || "",
    initNode: repairTemplateFields
      ? template.initNode || ""
      : cleanString(table && table.initNode, 500) || (template && template.initNode) || "",
    insertNode: repairTemplateFields
      ? template.insertNode || ""
      : cleanString(table && table.insertNode, 500) || (template && template.insertNode) || "",
    updateNode: repairTemplateFields
      ? template.updateNode || ""
      : cleanString(table && table.updateNode, 500) || (template && template.updateNode) || "",
    deleteNode: repairTemplateFields
      ? template.deleteNode || ""
      : cleanString(table && table.deleteNode, 500) || (template && template.deleteNode) || "",
    enabled: table && table.enabled === false ? false : true,
    inject: table && table.inject === false ? false : true,
    rows: Array.isArray(table && table.rows) ? table.rows.map((row) => normalizeRow(row, columns)) : [],
    cellHistory: Array.isArray(table && table.cellHistory) ? table.cellHistory : [],
    hashSheet: Array.isArray(table && table.hashSheet) ? table.hashSheet : [],
    deletedRows: Array.isArray(table && table.deletedRows) ? table.deletedRows.slice(0, 50) : [],
    updated_at: cleanString(table && table.updated_at, 80) || nowIso()
  });
  if (Array.isArray(table && table.rows) && table.rows.length) {
    const inputRows = table.rows.map((row) => normalizeRow(row, columns));
    const currentRows = normalized.rows || [];
    const sameShape = inputRows.length === currentRows.length && inputRows.every((row, index) => {
      return JSON.stringify(row.cells) === JSON.stringify((currentRows[index] || {}).cells || {});
    });
    if (!sameShape) rebuildSheetFromRows(normalized, inputRows);
  }
  return normalized;
}

function normalizeSession(session, chatId) {
  const templatesById = new Map(DEFAULT_TEMPLATES.map((item) => [item.id, item]));
  const existing = Array.isArray(session && session.tables) ? session.tables : [];
  const tables = [];
  for (const template of DEFAULT_TEMPLATES) {
    const table = existing.find((item) => item.id === template.id || item.template_id === template.id);
    tables.push(normalizeTable(table || tableFromTemplate(template), template));
  }
  for (const table of existing) {
    if (templatesById.has(table.id) || templatesById.has(table.template_id)) continue;
    tables.push(normalizeTable(table));
  }
  return {
    chat_id: safeChatId((session && session.chat_id) || chatId),
    tables,
    auto: {
      turns_since_update: Number.isInteger(session && session.auto && session.auto.turns_since_update)
        ? session.auto.turns_since_update
        : 0,
      last_update_at: cleanString(session && session.auto && session.auto.last_update_at, 80)
    },
    updated_at: cleanString(session && session.updated_at, 80) || nowIso()
  };
}

function subjectValue(table, row) {
  const firstColumn = table && Array.isArray(table.columns) ? table.columns[0] : "";
  return normalizeCell(row && row.cells && row.cells[firstColumn]);
}

function sameSubject(left, right) {
  return normalizeCell(left).toLowerCase() === normalizeCell(right).toLowerCase();
}

function tableHasSubject(table, subject) {
  const name = normalizeCell(subject);
  if (!table || !name) return true;
  return (table.rows || []).some((row) => sameSubject(subjectValue(table, row), name));
}

function setColumnByIndex(table, row, index, value) {
  const column = table && Array.isArray(table.columns) ? table.columns[index] : "";
  if (!column) return;
  row[column] = normalizeCell(value);
}

function characterFromContext(context) {
  if (context && context.character && context.character.name) return context.character;
  if (context && context.name) return context;
  return null;
}

function activeCharacterName(context) {
  return normalizeCell(characterFromContext(context) && characterFromContext(context).name);
}

function inferPrimaryCharacterName(session, context = {}) {
  const charName = activeCharacterName(context);
  if (charName) return charName;
  for (const table of (session && session.tables || []).filter((item) => item.id === "character_traits" || item.id === "relationship")) {
    for (const row of table.rows || []) {
      const name = normalizeRoleName(subjectValue(table, row), context);
      if (name && !isUserLike(name)) return name;
    }
  }
  return "";
}

function activeUserName(context = {}) {
  return normalizeCell(context.userName || context.user_display_name || context.userDisplayName);
}

function normalizeRoleName(value, context = {}) {
  const text = normalizeCell(value);
  if (!text) return "";
  const lower = text.toLowerCase();
  const charName = activeCharacterName(context);
  if (["<char>", "char", "assistant"].includes(lower) || ["我", "助手"].includes(text)) {
    return charName || text;
  }
  if (isUserLike(text)) return activeUserName(context) || "<user>";
  return text;
}

function collectKnownCharacters(session, context = {}) {
  const names = new Map();
  const character = characterFromContext(context);
  const charName = activeCharacterName(context);
  if (charName) names.set(charName.toLowerCase(), { name: charName, character });
  for (const table of (session.tables || []).filter((item) => item.id === "character_traits" || item.id === "relationship")) {
    for (const row of table.rows || []) {
      const name = normalizeRoleName(subjectValue(table, row), context);
      if (!name || isUserLike(name)) continue;
      if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), { name, character: name === charName ? character : null });
    }
  }
  return [...names.values()];
}

function buildRequiredCharacterOperations(session, context) {
  const knownCharacters = collectKnownCharacters(session, context);
  if (!knownCharacters.length) return [];
  const operations = [];
  const traitsTable = (session.tables || []).find((table) => table.id === "character_traits");
  const relationshipTable = (session.tables || []).find((table) => table.id === "relationship");

  for (const item of knownCharacters) {
    const name = item.name;
    const character = item.character;
    if (traitsTable && !tableHasSubject(traitsTable, name)) {
      const row = Object.fromEntries((traitsTable.columns || []).map((column) => [column, ""]));
      setColumnByIndex(traitsTable, row, 0, name);
      operations.push({
        op: "insert",
        table_id: traitsTable.id,
        row,
        reason: "required character traits initialization"
      });
    }

    if (relationshipTable && !tableHasSubject(relationshipTable, name)) {
      const row = Object.fromEntries((relationshipTable.columns || []).map((column) => [column, ""]));
      setColumnByIndex(relationshipTable, row, 0, name);
      operations.push({
        op: "insert",
        table_id: relationshipTable.id,
        row,
        reason: "required relationship initialization"
      });
    }
  }

  return operations;
}

function mergeDuplicateSubjectRows(table, context = {}) {
  if (!table || !Array.isArray(table.rows) || !table.rows.length) return [];
  const applied = [];
  const bySubject = new Map();
  const nextRows = [];
  for (const row of table.rows) {
    const normalized = normalizeRoleName(subjectValue(table, row), context);
    if (table.id === "relationship" && isUserLike(normalized)) {
      applied.push({ op: "delete", table_id: table.id, row_id: row.id, reason: "relationship subject cannot be <user>" });
      continue;
    }
    if (!normalized) {
      nextRows.push(row);
      continue;
    }
    const key = normalized.toLowerCase();
    if (!bySubject.has(key)) {
      const cells = { ...row.cells, [table.columns[0]]: normalized };
      const nextRow = { ...row, cells };
      bySubject.set(key, nextRow);
      nextRows.push(nextRow);
      if (subjectValue(table, row) !== normalized) {
        applied.push({ op: "update", table_id: table.id, row_id: row.id, reason: "normalize role subject" });
      }
      continue;
    }
    const target = bySubject.get(key);
    for (const column of table.columns || []) {
      if (!normalizeCell(target.cells[column]) && normalizeCell(row.cells[column])) {
        target.cells[column] = normalizeCell(row.cells[column]);
      }
    }
    applied.push({ op: "delete", table_id: table.id, row_id: row.id, reason: "merge duplicate subject row" });
  }
  if (applied.length) {
    rebuildSheetFromRows(table, nextRows);
    table.updated_at = nowIso();
  }
  return applied;
}

function normalizeRoleColumn(table, columnIndex, context = {}) {
  const column = table && Array.isArray(table.columns) ? table.columns[columnIndex] : "";
  if (!column) return [];
  const applied = [];
  for (const row of table.rows || []) {
    const value = normalizeRoleName(row.cells[column], context);
    if (value && value !== row.cells[column]) {
      updateSheetRow(table, row.id, { [column]: value }, "normalize role cell");
      applied.push({ op: "update", table_id: table.id, row_id: row.id, reason: "normalize role cell" });
    }
  }
  if (applied.length) table.updated_at = nowIso();
  return applied;
}

function joinUniqueCellValues(...values) {
  const parts = [];
  for (const value of values) {
    for (const part of normalizeCell(value).split("/")) {
      const item = normalizeCell(part, 120);
      if (item && !parts.includes(item)) parts.push(item);
    }
  }
  return parts.join("/");
}

function mergeDuplicateRowsByColumns(table, keyIndexes, mergeIndexes = []) {
  if (!table || !Array.isArray(table.rows) || !table.rows.length) return [];
  const columns = table.columns || [];
  const applied = [];
  const byKey = new Map();
  const nextRows = [];
  for (const row of table.rows) {
    const key = keyIndexes.map((index) => normalizeCell(row.cells[columns[index]])).join("\u0001").toLowerCase();
    if (!key.trim()) {
      nextRows.push(row);
      continue;
    }
    if (!byKey.has(key)) {
      byKey.set(key, row);
      nextRows.push(row);
      continue;
    }
    const target = byKey.get(key);
    for (const index of mergeIndexes) {
      const column = columns[index];
      if (!column) continue;
      target.cells[column] = joinUniqueCellValues(target.cells[column], row.cells[column]);
    }
    for (const column of columns) {
      if (!normalizeCell(target.cells[column]) && normalizeCell(row.cells[column])) {
        target.cells[column] = normalizeCell(row.cells[column]);
      }
    }
    applied.push({ op: "delete", table_id: table.id, row_id: row.id, reason: "merge duplicate row" });
  }
  if (applied.length) {
    rebuildSheetFromRows(table, nextRows);
    table.updated_at = nowIso();
  }
  return applied;
}

function reconcileSessionInvariants(session, context = {}) {
  const applied = [];
  const traitsTable = (session.tables || []).find((table) => table.id === "character_traits");
  const relationshipTable = (session.tables || []).find((table) => table.id === "relationship");
  if (traitsTable) applied.push(...mergeDuplicateSubjectRows(traitsTable, context));
  if (relationshipTable) applied.push(...mergeDuplicateSubjectRows(relationshipTable, context));
  for (const tableId of ["tasks", "events", "items"]) {
    const table = (session.tables || []).find((item) => item.id === tableId);
    if (table) applied.push(...normalizeRoleColumn(table, 0, context));
  }
  const eventsTable = (session.tables || []).find((table) => table.id === "events");
  if (eventsTable) applied.push(...mergeDuplicateRowsByColumns(eventsTable, [0, 1, 2, 3], [4]));
  const tasksTable = (session.tables || []).find((table) => table.id === "tasks");
  if (tasksTable) applied.push(...mergeDuplicateRowsByColumns(tasksTable, [0, 1, 2], [3]));
  const itemsTable = (session.tables || []).find((table) => table.id === "items");
  if (itemsTable) applied.push(...mergeDuplicateRowsByColumns(itemsTable, [0, 2], [1, 3]));
  const spaceTime = (session.tables || []).find((table) => table.id === "space_time");
  if (spaceTime && spaceTime.rows.length > 1) {
    const keep = spaceTime.rows[spaceTime.rows.length - 1];
    rebuildSheetFromRows(spaceTime, [keep]);
    spaceTime.updated_at = nowIso();
    applied.push({ op: "delete", table_id: spaceTime.id, reason: "space_time keeps only latest row" });
  }
  return applied;
}

function createMemoryStore({ memoryPath, logsPath }) {
  function loadAll() {
    const raw = readJson(memoryPath, { version: 1, sessions: [] });
    return {
      version: 1,
      sessions: Array.isArray(raw.sessions) ? raw.sessions : []
    };
  }

  function saveAll(data) {
    writeJson(memoryPath, {
      version: 1,
      sessions: data.sessions.map((session) => normalizeSession(session, session.chat_id))
    });
  }

  function getSession(chatId) {
    const id = safeChatId(chatId);
    const data = loadAll();
    const current = data.sessions.find((session) => session.chat_id === id);
    const session = normalizeSession(current || { chat_id: id }, id);
    if (!current) {
      data.sessions.unshift(session);
      saveAll(data);
    }
    return session;
  }

  function saveSession(session) {
    const normalized = normalizeSession(session, session.chat_id);
    const data = loadAll();
    data.sessions = data.sessions.filter((item) => item.chat_id !== normalized.chat_id);
    data.sessions.unshift(normalized);
    saveAll(data);
    return normalized;
  }

  function resetSession(chatId) {
    return saveSession({ chat_id: safeChatId(chatId), tables: DEFAULT_TEMPLATES.map(tableFromTemplate), auto: {} });
  }

  function loadLogs() {
    return readJson(logsPath, []);
  }

  function saveLogs(logs) {
    writeJson(logsPath, logs.slice(0, 300));
  }

  function appendLog(log) {
    const item = {
      id: uid("memlog"),
      created_at: nowIso(),
      ...log
    };
    const logs = loadLogs();
    logs.unshift(item);
    saveLogs(logs);
    return item;
  }

  function getLogs(chatId) {
    const id = safeChatId(chatId);
    return loadLogs().filter((log) => log.chat_id === id).slice(0, 50);
  }

  function renderPrompt(chatId) {
    const session = getSession(chatId);
    const parts = [];
    for (const table of session.tables.filter((item) => item.enabled && item.inject && item.rows.length)) {
      parts.push(`## ${table.name}`);
      if (table.description) parts.push(`说明: ${table.description}`);
      parts.push(table.columns.join(","));
      for (const row of table.rows.slice(-80)) {
        parts.push(table.columns.map((column) => row.cells[column] || "").join(","));
      }
      parts.push("");
    }
    if (!parts.length) return "";
    return [
      "[Memory Tables]",
      "以下是已整理的长期记忆表格。请把它作为稳定事实参考；如与最新聊天冲突，以最新聊天为准。",
      "",
      parts.join("\n").trim()
    ].join("\n");
  }

  function applyOperations(chatId, operations, meta = {}) {
    const session = getSession(chatId);
    const applied = [];
    const skipped = [];
    for (const raw of sortMemoryOperations(Array.isArray(operations) ? operations : [], session)) {
      const op = cleanString(raw && raw.op, 20).toLowerCase();
      const tableId = cleanString(raw && (raw.table_id || raw.tableId || raw.table), 120);
      const table = session.tables.find((item) => item.id === tableId || item.name === tableId);
      if (!table || !["insert", "update", "delete"].includes(op)) {
        skipped.push({ operation: raw, reason: "unknown table or op" });
        continue;
      }
      if (op === "insert") {
        const cells = raw.row && typeof raw.row === "object" ? raw.row : raw.cells;
        if (!cells || typeof cells !== "object") {
          skipped.push({ operation: raw, reason: "missing row cells" });
          continue;
        }
        const row = normalizeRow({
          id: cleanString(raw.row_id || raw.rowId, 80) || uid("row"),
          cells,
          source: meta.source || "memory-model",
          confidence: raw.confidence,
          created_at: nowIso(),
          updated_at: nowIso()
        }, table.columns);
        if (!Object.values(row.cells).some(Boolean)) {
          skipped.push({ operation: raw, reason: "empty row" });
          continue;
        }
        if (table.id === "relationship" && isUserLike(row.cells[table.columns[0]])) {
          skipped.push({ operation: raw, reason: "relationship subject cannot be <user>" });
          continue;
        }
        if (table.id === "space_time" && table.rows.length) {
          updateSheetRow(table, table.rows[0].id, row.cells, cleanString(raw.reason, 300) || "tableEdit spacetime refresh");
          table.updated_at = nowIso();
          applied.push({ op: "update", table_id: table.id, row_id: table.rows[0].id });
          continue;
        }
        insertSheetRow(table, row);
        table.updated_at = nowIso();
        applied.push({ op, table_id: table.id, row_id: row.id });
        continue;
      }
      const rowId = cleanString(raw.row_id || raw.rowId, 80);
      const rowIndex = Number.isInteger(raw.row_index) ? raw.row_index : Number(raw.rowIndex);
      const row = rowId
        ? table.rows.find((item) => item.id === rowId)
        : Number.isInteger(rowIndex) && rowIndex >= 0
          ? table.rows[rowIndex]
          : null;
      if (!row) {
        skipped.push({ operation: raw, reason: "unknown row" });
        continue;
      }
      if (op === "delete") {
        deleteSheetRow(table, row.id);
        table.updated_at = nowIso();
        applied.push({ op, table_id: table.id, row_id: row.id });
        continue;
      }
      const patch = raw.patch && typeof raw.patch === "object" ? raw.patch : raw.cells;
      if (!patch || typeof patch !== "object") {
        skipped.push({ operation: raw, reason: "missing patch" });
        continue;
      }
      if (table.id === "relationship" && Object.prototype.hasOwnProperty.call(patch, table.columns[0]) && isUserLike(patch[table.columns[0]])) {
        skipped.push({ operation: raw, reason: "relationship subject cannot be <user>" });
        continue;
      }
      updateSheetRow(table, row.id, patch, cleanString(raw.reason, 300));
      row.updated_at = nowIso();
      table.updated_at = nowIso();
      applied.push({ op, table_id: table.id, row_id: row.id });
    }
    session.auto.turns_since_update = 0;
    session.auto.last_update_at = nowIso();
    session.updated_at = nowIso();
    saveSession(session);
    return { session, applied, skipped };
  }

  function rebuildFromTables(chatId, tablePayloads, meta = {}) {
    const session = getSession(chatId);
    const applied = [];
    const skipped = [];
    const payloads = Array.isArray(tablePayloads) ? tablePayloads : [];
    for (const payload of payloads) {
      const tableIndex = Number(payload && payload.tableIndex);
      const table = Number.isInteger(tableIndex) && tableIndex >= 0
        ? session.tables[tableIndex]
        : session.tables.find((item) => item.name === cleanString(payload && payload.tableName, 160));
      if (!table || !Array.isArray(payload && payload.content)) {
        skipped.push({ table: payload && (payload.tableName || payload.tableIndex), reason: "unknown table or missing content" });
        continue;
      }
      const rows = payload.content.map((line) => {
        const values = Array.isArray(line) ? line : [];
        return normalizeRow({
          id: uid("row"),
          cells: Object.fromEntries((table.columns || []).map((column, index) => [column, values[index] ?? ""])),
          source: meta.source || "memory-rebuild",
          created_at: nowIso(),
          updated_at: nowIso()
        }, table.columns || []);
      }).filter((row) => Object.values(row.cells || {}).some(Boolean));
      rebuildSheetFromRows(table, rows);
      table.updated_at = nowIso();
      applied.push({ op: "rebuild", table_id: table.id, rows: rows.length });
    }
    session.auto.turns_since_update = 0;
    session.auto.last_update_at = nowIso();
    session.updated_at = nowIso();
    saveSession(session);
    return { session, applied, skipped };
  }

  function reconcileMemorySession(chatId, context = {}) {
    const session = getSession(chatId);
    const initResult = { applied: [], skipped: [] };
    const operations = buildRequiredCharacterOperations(session, context);
    let current = session;
    if (operations.length) {
      const appliedInit = applyOperations(chatId, operations, { source: "system:memory-reconcile" });
      current = appliedInit.session;
      initResult.applied = appliedInit.applied || [];
      initResult.skipped = appliedInit.skipped || [];
    }
    const invariantApplied = reconcileSessionInvariants(current, context);
    if (invariantApplied.length) {
      current.updated_at = nowIso();
      current = saveSession(current);
    }
    return {
      session: current,
      applied: [...initResult.applied, ...invariantApplied],
      skipped: initResult.skipped
    };
  }

  function ensureRequiredCharacterRows(chatId, character) {
    return reconcileMemorySession(chatId, { character });
  }

  function recordTurnAndCheckAuto(chatId, text, everyTurns = 3) {
    const session = getSession(chatId);
    session.auto.turns_since_update += 1;
    session.updated_at = nowIso();
    const important = /地点|位置|关系|好感|喜欢|讨厌|承诺|约定|任务|命令|物品|送给|拿到|记住|名字|身份|职业|事件|发生|离开|到达|受伤|生气|难过|开心/.test(text);
    const shouldRun = important || session.auto.turns_since_update >= Math.max(1, everyTurns);
    saveSession(session);
    return {
      shouldRun,
      reason: important ? "important_change" : shouldRun ? "turn_interval" : "deferred",
      turnsSinceUpdate: session.auto.turns_since_update
    };
  }

  return {
    templates: DEFAULT_TEMPLATES,
    getSession,
    saveSession,
    resetSession,
    renderPrompt,
    applyOperations,
    rebuildFromTables,
    reconcileMemorySession,
    ensureRequiredCharacterRows,
    appendLog,
    getLogs,
    recordTurnAndCheckAuto
  };
}

function splitFunctionArgs(argsText) {
  const args = [];
  let current = "";
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (const char of argsText) {
    if (quote) {
      current += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function parseDataObjectLiteral(value) {
  const source = cleanString(value, 20000)
    .replace(/([{,]\s*)(\d+)\s*:/g, '$1"$2":')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => JSON.stringify(inner.replace(/\\'/g, "'")));
  return JSON.parse(source);
}

function isUserLike(value) {
  return ["<user>", "user", "用户", "我"].includes(cleanString(value, 80).toLowerCase());
}

function operationPriority(op) {
  const value = cleanString(op && op.op, 20).toLowerCase();
  if (value === "update") return 0;
  if (value === "insert") return 1;
  if (value === "delete") return 2;
  return 3;
}

function operationRowIndex(op, session) {
  const tableId = cleanString(op && (op.table_id || op.tableId || op.table), 120);
  const table = session && session.tables ? session.tables.find((item) => item.id === tableId || item.name === tableId) : null;
  if (!table) return -1;
  const rowId = cleanString(op && (op.row_id || op.rowId), 80);
  if (rowId) return table.rows.findIndex((row) => row.id === rowId);
  const rowIndex = Number.isInteger(op && op.row_index) ? op.row_index : Number(op && op.rowIndex);
  return Number.isInteger(rowIndex) ? rowIndex : -1;
}

function sortMemoryOperations(operations, session = null) {
  return [...operations].sort((a, b) => {
    const pa = operationPriority(a);
    const pb = operationPriority(b);
    if (pa === 2 && pb === 2) return operationRowIndex(b, session) - operationRowIndex(a, session);
    return pa - pb;
  });
}

function parseTableEditOperations(text, session) {
  const raw = cleanString(text, 200000);
  const tagMatch = raw.match(/<tableEdit>([\s\S]*?)<\/tableEdit>/i);
  if (!tagMatch) return null;
  const body = tagMatch[1].replace(/<!--|-->/g, "");
  const functionRegex = /(insertRow|updateRow|deleteRow)\s*\(/g;
  const operations = [];
  let match;
  while ((match = functionRegex.exec(body)) !== null) {
    const name = match[1];
    let index = match.index + match[0].length;
    let depth = 1;
    let quote = "";
    let escaped = false;
    for (; index < body.length; index += 1) {
      const char = body[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (depth === 0) break;
    }
    const args = splitFunctionArgs(body.slice(match.index + match[0].length, index));
    const tableIndex = Number(args[0]);
    const table = session && session.tables ? session.tables[tableIndex] : null;
    if (!table) continue;
    if (name === "insertRow") {
      const data = parseDataObjectLiteral(args[1] || "{}");
      operations.push({
        op: "insert",
        table_id: table.id,
        row: Object.fromEntries((table.columns || []).map((column, colIndex) => [column, data[String(colIndex)] ?? ""])),
        reason: "tableEdit insert"
      });
      continue;
    }
    const rowIndex = Number(args[1]);
    const row = Number.isInteger(rowIndex) && rowIndex >= 0 ? table.rows[rowIndex] : null;
    if (!row) continue;
    if (name === "deleteRow") {
      operations.push({ op: "delete", table_id: table.id, row_id: row.id, reason: "tableEdit delete" });
      continue;
    }
    const data = parseDataObjectLiteral(args[2] || "{}");
    operations.push({
      op: "update",
      table_id: table.id,
      row_id: row.id,
      patch: Object.fromEntries(
        Object.entries(data)
          .map(([colIndex, value]) => [table.columns[Number(colIndex)], value])
          .filter(([column]) => column)
      ),
      reason: "tableEdit update"
    });
  }
  return { operations: sortMemoryOperations(operations, session), summary: "", parse_error: "" };
}

function parseOperationsText(text, session = null) {
  try {
    const tableEdit = parseTableEditOperations(text, session);
    if (tableEdit) return tableEdit;
  } catch (error) {
    return { operations: [], parse_error: error && error.message ? error.message : String(error) };
  }
  const raw = cleanString(text, 200000);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return { operations: [], parse_error: "No tableEdit tag or JSON object found." };
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return {
      operations: Array.isArray(parsed.operations) ? parsed.operations : [],
      summary: cleanString(parsed.summary, 1000),
      parse_error: ""
    };
  } catch (error) {
    return { operations: [], parse_error: error && error.message ? error.message : String(error) };
  }
}

function parseRebuildTablesText(text) {
  const raw = cleanString(text, 400000);
  const tagMatch = raw.match(/<新的表格>([\s\S]*?)<\/新的表格>/i) || raw.match(/<new_tables>([\s\S]*?)<\/new_tables>/i);
  const candidate = tagMatch ? tagMatch[1] : raw;
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : candidate;
  const start = source.indexOf("[");
  const end = source.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return { tables: [], parse_error: "No JSON table array found." };
  }
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    if (!Array.isArray(parsed)) return { tables: [], parse_error: "JSON result is not an array." };
    return { tables: parsed, parse_error: "" };
  } catch (error) {
    return { tables: [], parse_error: error && error.message ? error.message : String(error) };
  }
}

function relationshipUserText(value) {
  return cleanString(value, 2000).replace(/用户/g, "<user>");
}

function tablePromptName(table) {
  return table && table.id === "relationship" ? relationshipUserText(table.name) : table.name;
}

function columnPromptName(table, column) {
  return table && table.id === "relationship" ? relationshipUserText(column) : column;
}

function cellPromptValue(table, column, value) {
  if (table && table.id === "relationship") return relationshipUserText(value);
  if (String(value || "") === "用户") return "<user>";
  return value || "";
}

function memorySpeakerLabel(role, character, userName = "") {
  if (role === "user") return userName || "<user>";
  if (role === "assistant") return character && character.name ? character.name : "<char>";
  return role || "unknown";
}

function stripTableEditTags(value) {
  return String(value || "").replace(/<tableEdit>[\s\S]*?<\/tableEdit>/g, "").trim();
}

function recentMemoryMessages(messages, maxTurns = 9, maxChars = 10000) {
  const source = Array.isArray(messages) ? messages : [];
  const selected = [];
  let used = 0;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    const content = stripTableEditTags(message && message.content);
    if (!content) continue;
    if (selected.length >= maxTurns && used + content.length > maxChars) break;
    if (used + content.length > maxChars && selected.length > 0) break;
    selected.unshift({ ...message, content });
    used += content.length;
    if (selected.length >= maxTurns && used >= maxChars) break;
  }
  return selected;
}

function buildMemoryChatText({ messages, userInput, assistantReply, character, userName = "" }) {
  return [
    ...recentMemoryMessages(messages).map((message) => {
      return `${memorySpeakerLabel(message.role, character, userName)}: ${message.content || ""}`;
    }),
    userInput ? `${userName || "<user>"}: ${stripTableEditTags(userInput)}` : "",
    assistantReply ? `${memorySpeakerLabel("assistant", character, userName)}: ${stripTableEditTags(assistantReply)}` : ""
  ].filter(Boolean).join("\n");
}

function buildTableText(session) {
  return (session.tables || []).map((table, tableIndex) => {
    const rows = (table.rows || []).map((row, rowIndex) => {
      const data = Object.fromEntries((table.columns || []).map((column, colIndex) => {
        return [String(colIndex), cellPromptValue(table, column, row.cells[column])];
      }));
      return `[rowIndex:${rowIndex}] ${JSON.stringify(data)}`;
    });
    return [
      `[tableIndex:${tableIndex}] ${tablePromptName(table)} (${table.id})`,
      `说明: ${table.description || ""}`,
      table.note ? `note: ${table.id === "relationship" ? relationshipUserText(table.note) : table.note}` : "",
      table.initNode ? `initNode: ${table.id === "relationship" ? relationshipUserText(table.initNode) : table.initNode}` : "",
      table.insertNode ? `insertNode: ${table.id === "relationship" ? relationshipUserText(table.insertNode) : table.insertNode}` : "",
      table.updateNode ? `updateNode: ${table.id === "relationship" ? relationshipUserText(table.updateNode) : table.updateNode}` : "",
      table.deleteNode ? `deleteNode: ${table.id === "relationship" ? relationshipUserText(table.deleteNode) : table.deleteNode}` : "",
      `列: ${(table.columns || []).map((column, colIndex) => `[${colIndex}:${columnPromptName(table, column)}]`).join(" ")}`,
      rows.length ? rows.join("\n") : "(empty)"
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function buildHeaderText(session) {
  return (session.tables || []).map((table, tableIndex) => {
    return `[tableIndex:${tableIndex}] ${tablePromptName(table)} columns: ${(table.columns || []).map((column, colIndex) => `[${colIndex}:${columnPromptName(table, column)}]`).join(" ")}`;
  }).join("\n");
}

function tableToRebuildJson(table, tableIndex) {
  return {
    tableName: tablePromptName(table),
    tableIndex,
    columns: table.columns || [],
    content: (table.rows || []).map((row) => (table.columns || []).map((column) => cellPromptValue(table, column, row.cells[column])))
  };
}

function memoryTimeFormatRule() {
  return [
    "统一时间格式为 YYYY-MM-DD HH:MM；未知部分可以省略，例如 2023-10-01 12:00、2023-10-01 或 12:00。",
    "如果剧情没有给出精确日期或时间，不要补造；保留剧情原文中的时间表达，或将未知部分留空。",
    "十月、冬天/下雪、清晨、夜晚 等可以作为剧情时间表达保留。"
  ].join("\n");
}

function buildMemoryRebuildPrompt({ chatId, session, messages, userInput = "", assistantReply = "", character = null, userName = "" }) {
  const charName = character && character.name ? character.name : inferPrimaryCharacterName(session, {}) || "<char>";
  const chatCharacter = character || (charName !== "<char>" ? { name: charName } : null);
  const realUserName = normalizeCell(userName) || "<user>";
  const chatText = buildMemoryChatText({ messages, userInput, assistantReply, character: chatCharacter, userName: realUserName });
  const tablesJson = JSON.stringify((session.tables || []).map(tableToRebuildJson), null, 2);
  return [
    "你是一个专业的剧情记忆表格整理助手。请按 SillyTavern 记忆增强表格的“重整理”方式处理表格。",
    "只返回 <新的表格> 标签包裹的 JSON 数组，不要解释，不要思考过程。",
    "",
    "<整理规则>",
    "1. 修正格式错误，删除 data[0] 为空的行。此操作只允许整行处理。",
    "2. 补全空白/未知内容时必须有剧情依据，禁止捏造；没有依据的字段保持空字符串，不写 未知/unknown。",
    "3. 当“重要事件历史表格”(tableIndex: 4)超过 10 行时，检查重复或相似内容，适当合并或删除冗余行。此操作只允许整行处理。",
    "4. “角色与<user>社交表格”(tableIndex: 2)禁止重复角色名；如有重复，删除冗余整行。",
    "5. “时空表格”(tableIndex: 0)必须只包含一行，删除旧的时空行，只保留最新当前时空。",
    "6. 单元格超过 15 字时尽量简化；用 / 分割的项目超过 4 个时保留最重要的不超过 4 个。",
    "7. " + memoryTimeFormatRule(),
    "8. 地点格式参考 大区域>国家/地区>城市>具体地点；未知部分可以省略，例如 异世界>酒馆 或 医院病房。",
    "9. 单元格中禁止使用逗号，语义分割使用 /。",
    "10. string 中禁止出现双引号。",
    "11. 禁止插入与现有表格完全相同的行；决定插入前先检查当前表格。",
    "12. 必须保持原有 6 张表、tableIndex、表名、columns 不变，只改 content。",
    "</整理规则>",
    "",
    "<身份规则>",
    "user=" + realUserName,
    "char=" + charName,
    "assistant/我/<char> 都代表当前角色 " + charName + "；用户显示名是 " + realUserName + "。",
    "社交表格 tableIndex 2 的第一列必须是角色名，不能是用户本人。",
    "</身份规则>",
    "",
    "<identity>",
    "user=" + realUserName,
    "char=" + charName,
    "assistant_messages_are_char=true",
    "</identity>",
    "",
    "<聊天记录>",
    chatText || "(empty)",
    "</聊天记录>",
    "",
    "<当前表格>",
    tablesJson,
    "</当前表格>",
    "",
    "<新的表格>",
    tablesJson,
    "</新的表格>"
  ].join("\n");
}

function buildMemoryUpdatePrompt({ chatId, session, messages, userInput, assistantReply, character = null, userName = "" }) {
  const charName = character && character.name ? character.name : inferPrimaryCharacterName(session, {}) || "<char>";
  const chatCharacter = character || (charName !== "<char>" ? { name: charName } : null);
  const realUserName = normalizeCell(userName) || "<user>";
  const chatText = buildMemoryChatText({ messages, userInput, assistantReply, character: chatCharacter, userName: realUserName });
  return [
    "你是一个专业的表格整理助手。请根据用户提供的<聊天记录>和<当前表格>，并遵循<操作规则>，使用<tableEdit>标签和指定函数输出表格修改。",
    "请根据<聊天记录>和<当前表格>，并严格遵守<操作规则>和<重要操作原则>，对表格进行必要的增、删、改操作。",
    "你的回复必须只包含一个 <tableEdit> 标签及其中的函数调用，不要包含任何其他解释或思考过程。如果没有必要修改，返回空的 <tableEdit></tableEdit>。",
    "角色标识必须严格区分：<user> 表示用户本人；<char> 表示当前扮演角色，当前 <char> 名称是 " + charName + "。聊天记录中以角色名开头的 assistant 发言都视为 <char> 的发言。",
    "<identity>",
    "user=" + realUserName,
    "char=" + charName,
    "assistant_messages_are_char=true",
    "Use these real display names in character/name columns when possible. Keep empty cells empty; do not write 未知/unknown just to fill blanks.",
    "If the active role is the assistant/character, write the real char name (" + charName + "), not 我/assistant/<char>.",
    "If the user is referenced as a person and a user display name is provided, write the real user name (" + realUserName + "), not <user>.",
    "</identity>",
    "",
    "# 增删改dataTable操作方法：",
    "- 当你需要根据<聊天记录>和<当前表格>对表格进行增删改时，请在<tableEdit>标签中使用 JavaScript 函数的写法调用函数，并使用下面的 OperateRule。",
    "",
    "## 操作规则 (必须严格遵守)",
    "<OperateRule>",
    "- 在某个表格中插入新行时，使用 insertRow 函数：",
    "insertRow(tableIndex:number, data:{[colIndex:number]:string|number})",
    "例如：insertRow(0, {\"0\":\"2021-09-01\", \"1\":\"12:00\", \"2\":\"阳台\", \"3\":\"小花\"})",
    "- 在某个表格中删除行时，使用 deleteRow 函数：",
    "deleteRow(tableIndex:number, rowIndex:number)",
    "例如：deleteRow(0, 0)",
    "- 在某个表格中更新行时，使用 updateRow 函数：",
    "updateRow(tableIndex:number, rowIndex:number, data:{[colIndex:number]:string|number})",
    "例如：updateRow(0, 0, {\"3\":\"惠惠\"})",
    "</OperateRule>",
    "",
    "# 重要操作原则 (必须遵守)",
    "- 当<user>要求修改表格时，<user>的要求优先级最高。",
    "- 每次回复都必须根据剧情在正确的位置进行增、删、改操作，禁止捏造信息和填入未知。",
    "- 使用 insertRow 函数插入行时，请为所有已知列提供对应数据，并检查 data 是否包含所有已知 colIndex；未知列留空字符串。",
    "- " + memoryTimeFormatRule(),
    "- 单元格中禁止使用逗号，语义分割应使用 / 。",
    "- string 中禁止出现双引号。",
    "- 社交表格(tableIndex: 2)中禁止把<user>作为角色名。反例：insertRow(2, {\"0\":\"<user>\",\"1\":\"未知\",\"2\":\"无\",\"3\":\"低\"})",
    "- <tableEdit>标签内必须使用<!-- -->标记进行注释。",
    "- 插入与现有表格内容完全相同的行是禁止的，应优先 update 已有行。",
    "- 删除操作放在最后；多个 deleteRow 删除同表多行时，先删较大的 rowIndex。",
    "",
    "<表格归类规则>",
    "tableIndex 0 时空表格：只记录当前/最新的日期、时间、地点、此地角色。纯场景状态、当前位置、当前日期时间优先放这里，不要放进重要事件历史。",
    "tableIndex 1 角色特征表格：记录稳定外貌、性格、身份、职业、爱好、住所等长期设定。",
    "tableIndex 2 角色与<user>社交表格：记录角色对<user>的关系、态度、好感。第一列必须是角色名，例如 " + charName + " 或其他角色名；禁止把 <user> 或 用户 本人作为角色名写入这一表。",
    "tableIndex 3 任务、命令或者约定表格：记录明确任务、承诺、命令、约定及持续时间。",
    "tableIndex 4 重要事件历史表格：只记录 <user> 或角色已经经历、且会影响后续剧情/关系的事件或里程碑。事件里可以带日期地点，但不要用它代替时空表格。",
    "tableIndex 5 重要物品表格：记录重要物品、归属、描述和剧情意义。",
    "Routing invariant: tableIndex 2 first column must be a character name, never <user>; tableIndex 0 is current space/time; tableIndex 4 is plot events only.",
    "</表格归类规则>",
    "",
    "<输出示例>",
    "<tableEdit>",
    "<!--",
    "insertRow(0, {\"0\":\"第二天\", \"1\":\"清晨\", \"2\":\"医院病房\", \"3\":\"<user>/" + charName + "\"})",
    "insertRow(2, {\"0\":\"" + charName + "\", \"1\":\"照顾者\", \"2\":\"保护/安抚\", \"3\":\"高\"})",
    "insertRow(4, {\"0\":\"<user>\", \"1\":\"<user>在车祸后醒来并产生过去争执的闪回\", \"2\":\"醒来当天\", \"3\":\"医院病房\", \"4\":\"不安/困惑\"})",
    "-->",
    "</tableEdit>",
    "</输出示例>",
    "",
    `<chat_id>${chatId}</chat_id>`,
    "<表头信息>",
    buildHeaderText(session),
    "</表头信息>",
    "<当前表格>",
    buildTableText(session),
    "</当前表格>",
    "<recent_chat>",
    chatText || "(empty)",
    "</recent_chat>"
  ].join("\n");
}

module.exports = {
  createMemoryStore,
  buildMemoryUpdatePrompt,
  buildMemoryRebuildPrompt,
  parseOperationsText,
  parseRebuildTablesText
};
