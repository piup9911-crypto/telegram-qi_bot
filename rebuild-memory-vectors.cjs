// Keep the core-store import explicit: private/trash remain outside the model
// index, while all model-readable records now come from LMC.
const fs = require("fs");
require("./core-memory-store.cjs");
const { lmcSearchableRecords } = require("./lmc-memory-store.cjs");
const {
  VECTOR_INDEX_PATH,
  VECTOR_MODEL,
  indexMemoryRecords
} = require("./memory-vector.cjs");

async function main() {
  const records = lmcSearchableRecords({
    allowHistorical: true,
    allowSearchEvidence: true
  });
  // A rebuild must also drop retired small/large-summary vectors rather than
  // merely append LMC records to the old index.
  try {
    fs.unlinkSync(VECTOR_INDEX_PATH);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  const result = await indexMemoryRecords(records);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        model: VECTOR_MODEL,
        indexPath: VECTOR_INDEX_PATH,
        recordCount: records.length,
        ...result
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
