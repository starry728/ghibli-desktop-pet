/**
 * 宠物目录：加载 server/data/pets.json，并合并「AI 领养文案」与「领养状态」。
 */
import fsp from 'node:fs/promises';
import { JsonStore } from './lib/store.js';
import { PETS_FILE, COPY_FILE, ADOPTIONS_FILE } from './config.js';

const EMPTY_ADOPTIONS = { version: 1, adoptions: {} };
const EMPTY_COPY = { version: 1, generatedAt: null, model: null, items: {} };

export const copyStore = new JsonStore(COPY_FILE, EMPTY_COPY);
export const adoptionStore = new JsonStore(ADOPTIONS_FILE, EMPTY_ADOPTIONS);

let catalog = { version: 1, pets: [], films: [], source: '' };

export async function loadCatalog() {
  const raw = JSON.parse(await fsp.readFile(PETS_FILE, 'utf8'));
  catalog = {
    version: raw.version ?? 1,
    generatedAt: raw.generatedAt ?? null,
    source: raw.source ?? '',
    films: raw.films ?? [],
    pets: raw.pets ?? [],
  };
  return catalog;
}

export function getCatalog() {
  return catalog;
}

export function getFilm(key) {
  return catalog.films.find((f) => f.key === key) ?? null;
}

export function getPetRaw(id) {
  return catalog.pets.find((p) => p.id === id) ?? null;
}

/** 合并 AI 文案 + 领养状态后的宠物视图 */
export async function getPetView(id) {
  const pet = getPetRaw(id);
  if (!pet) return null;
  const copy = await copyStore.load();
  const adoptions = await adoptionStore.load();
  return decorate(pet, copy.items?.[id] ?? null, adoptions.adoptions?.[id] ?? null);
}

export async function listPetViews({ film, rarity, adopted, q, sort } = {}) {
  const copy = await copyStore.load();
  const adoptions = await adoptionStore.load();

  let items = catalog.pets.map((p) => decorate(p, copy.items?.[p.id] ?? null, adoptions.adoptions?.[p.id] ?? null));

  if (film) items = items.filter((p) => p.film.key === film);
  if (rarity) items = items.filter((p) => p.rarity === rarity);
  if (adopted === true) items = items.filter((p) => p.adopted);
  if (adopted === false) items = items.filter((p) => !p.adopted);
  if (q) {
    const needle = String(q).toLowerCase();
    items = items.filter((p) =>
      [p.name, p.nameJa, p.nameEn, p.film.zh, p.film.en, ...(p.tags || [])]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }

  const order = { SSR: 0, SR: 1, R: 2, N: 3 };
  if (sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  else if (sort === 'film') items.sort((a, b) => a.film.year - b.film.year || a.filmOrderIndex - b.filmOrderIndex);
  else items.sort((a, b) => (order[a.rarity] - order[b.rarity]) || (a.film.year - b.film.year) || (a.filmOrderIndex - b.filmOrderIndex));

  return items;
}

function decorate(pet, copy, adoption) {
  return {
    ...pet,
    adopted: Boolean(adoption),
    adoption: adoption
      ? {
          adoptedAt: adoption.adoptedAt,
          adopter: adoption.adopter ?? '无名旅人',
          timesAdopted: adoption.timesAdopted ?? 1,
        }
      : null,
    copy: copy
      ? {
          tagline: copy.tagline ?? '',
          text: copy.text ?? '',
          tags: copy.tags ?? [],
          care: copy.care ?? '',
          model: copy.model ?? null,
          generatedAt: copy.generatedAt ?? null,
          source: copy.source ?? 'ai',
        }
      : null,
  };
}

/** 统计信息 */
export async function getStats() {
  const copy = await copyStore.load();
  const adoptions = await adoptionStore.load();
  const total = catalog.pets.length;
  const withCopy = catalog.pets.filter((p) => copy.items?.[p.id]).length;
  const adoptedCount = catalog.pets.filter((p) => adoptions.adoptions?.[p.id]).length;
  return {
    total,
    withCopy,
    copyComplete: total > 0 && withCopy >= total,
    adopted: adoptedCount,
    pending: total - adoptedCount,
    films: catalog.films.length,
    copyGeneratedAt: copy.generatedAt ?? null,
    copyModel: copy.model ?? null,
  };
}
