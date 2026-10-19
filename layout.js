// The rows and tiles the page shows: the defaults in instruments.js, with the
// changes made from the page on top. The changes are kept in a file of their
// own as edits (rows added, rows removed, the tile list), not as a copy of the
// whole layout, so that rows added to instruments.js later still appear.
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OVERVIEW, SECTIONS } from './instruments.js';

// A change that cannot be made as asked, said back to the page as it is.
export class Refusal extends Error {}

const noEdits = () => ({ added: {}, removed: [], overview: null });

// A table is known by its section, card and label, which together are unique.
const keyOf = (section, card, group) => `${section.id}/${card.title}/${group.label}`;
const rowsOf = (sections) => sections.flatMap((s) => s.cards.flatMap((c) => c.groups.filter((g) => g.kind === 'quote').flatMap((g) => g.items)));

export async function openLayout(file) {
  let edits = noEdits();
  try {
    edits = { ...noEdits(), ...JSON.parse(await readFile(file, 'utf8')) };
  } catch (err) {
    // No file means nothing has been changed; one that does not parse is worth a line in the log.
    if (err.code !== 'ENOENT') console.error(`${path.basename(file)} was not read, so the default layout is shown: ${err.message}`);
  }

  // Writes go one after another, each to a scratch file first, so a crash
  // mid-write never leaves a half-written layout behind.
  let saving = Promise.resolve();
  const save = () => {
    const text = JSON.stringify(edits, null, 2);
    saving = saving.catch(() => {}).then(async () => {
      await writeFile(`${file}.tmp`, text);
      await rename(`${file}.tmp`, file);
    });
    return saving;
  };

  // Every table of quotes carries its `key`, by which rows are added to it.
  // The currency grid has none: its currencies follow from the USD pairs.
  function current() {
    const removed = new Set(edits.removed);
    const sections = SECTIONS.map((section) => ({
      ...section,
      cards: section.cards.map((card) => ({
        ...card,
        groups: card.groups.map((group) => {
          if (group.kind !== 'quote') return group;
          const key = keyOf(section, card, group);
          return { ...group, key, items: [...group.items.filter((item) => !removed.has(item.symbol)), ...(edits.added[key] ?? [])] };
        }),
      })),
    }));
    const shown = new Set(rowsOf(sections).map((item) => item.symbol));
    // A removed row keeps its place among the tiles, so that undoing the removal brings its tile back too.
    return { sections, overview: (edits.overview ?? OVERVIEW).filter((symbol) => shown.has(symbol)) };
  }

  const isShown = (symbol) => rowsOf(current().sections).some((item) => item.symbol === symbol);

  // Adds a row to the end of a table. A default row that was removed from
  // this very table comes back in its old place, with everything
  // instruments.js says about it (its proxy, its constituents).
  function add(key, item) {
    const home = SECTIONS.flatMap((s) => s.cards.flatMap((c) => c.groups.map((g) => ({ key: keyOf(s, c, g), group: g }))))
      .find((entry) => entry.key === key && entry.group.kind === 'quote');
    if (!home) throw new Refusal('That table is not on the page.');
    if (isShown(item.symbol)) throw new Refusal(`${item.symbol} is already on the page.`);
    if (home.group.items.some((row) => row.symbol === item.symbol)) {
      edits.removed = edits.removed.filter((symbol) => symbol !== item.symbol);
    } else {
      edits.added[key] = [...(edits.added[key] ?? []), item];
    }
    return save();
  }

  function remove(symbol) {
    if (!isShown(symbol)) throw new Refusal(`${symbol} is not on the page.`);
    for (const [key, items] of Object.entries(edits.added)) {
      edits.added[key] = items.filter((item) => item.symbol !== symbol);
      if (!edits.added[key].length) delete edits.added[key];
    }
    if (rowsOf(SECTIONS).some((item) => item.symbol === symbol)) edits.removed = [...new Set([...edits.removed, symbol])];
    return save();
  }

  // Shows a row as a tile at the top of the page (at the end of the tiles), or stops showing it.
  function pin(symbol, pinned) {
    if (pinned && !isShown(symbol)) throw new Refusal(`${symbol} is not on the page.`);
    const tiles = (edits.overview ?? OVERVIEW).filter((s) => s !== symbol);
    edits.overview = pinned ? [...tiles, symbol] : tiles;
    return save();
  }

  function reset() {
    edits = noEdits();
    return save();
  }

  return { current, add, remove, pin, reset };
}
