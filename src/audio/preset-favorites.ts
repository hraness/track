/**
 * Starred presets (`preset fav`, `*` in the browser): one JSON list beside
 * the user patch library, `$XDG_DATA_HOME/dawg/preset-favorites.json`
 * (`DAWG_PRESET_FAVORITES` overrides). A missing or unreadable file is no
 * favorites; writes go through a temp file and a rename.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function favoritesFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DAWG_PRESET_FAVORITES) return env.DAWG_PRESET_FAVORITES;
  const data =
    env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  return join(data, "dawg", "preset-favorites.json");
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export async function loadFavorites(
  file = favoritesFile(),
): Promise<Set<string>> {
  try {
    const json: unknown = JSON.parse(await readFile(file, "utf8"));
    const list = Array.isArray(json)
      ? json
      : typeof json === "object" && json && "favorites" in json
        ? (json as { favorites: unknown }).favorites
        : [];
    return new Set(
      (Array.isArray(list) ? list : []).filter(
        (name): name is string => typeof name === "string" && NAME.test(name),
      ),
    );
  } catch {
    return new Set();
  }
}

export async function saveFavorites(
  favorites: ReadonlySet<string>,
  file = favoritesFile(),
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(
    temp,
    `${JSON.stringify({ favorites: [...favorites].sort() }, null, 2)}\n`,
  );
  await rename(temp, file);
}
