import { NextRequest } from "next/server";

const ALLOWED_PREFIXES = [
  "https://www.loc.gov/",
  "https://chroniclingamerica.loc.gov/",
  "https://tile.loc.gov/",
];

const UA =
  "Herald/0.1 (mailto:timhartnett29@gmail.com; +https://github.com/HistorySims/herald)";

function isAllowed(url: string): boolean {
  return ALLOWED_PREFIXES.some((p) => url.startsWith(p));
}

interface ChunkUrlParts {
  lccn: string;
  date: string;
  ed: string;
  seq: string;
}

function extractParts(url: string): ChunkUrlParts | null {
  const m1 = url.match(
    /^https:\/\/chroniclingamerica\.loc\.gov\/lccn\/([^/]+)\/([^/]+)\/(ed-\d+)\/(seq-\d+)\.(?:jpg|jp2|pdf)$/
  );
  if (m1) return { lccn: m1[1], date: m1[2], ed: m1[3], seq: m1[4] };
  const m2 = url.match(
    /^https:\/\/www\.loc\.gov\/resource\/([^/]+)\/([^/]+)\/(ed-\d+)\/(seq-\d+)(?:\.(?:jpg|jp2|pdf))?\/?$/
  );
  if (m2) return { lccn: m2[1], date: m2[2], ed: m2[3], seq: m2[4] };
  return null;
}

async function tryFetchImage(url: string): Promise<Response | null> {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "image/jpeg, image/png, image/*, */*",
      },
      redirect: "follow",
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get("Content-Type") ?? "";
    if (!ct.startsWith("image/")) return null;
    return resp;
  } catch {
    return null;
  }
}

interface LocFile {
  url?: string;
  mimetype?: string;
}
interface LocResource {
  url?: string;
  files?: LocFile[];
}
interface LocResourceJson {
  resources?: LocResource[];
  image_url?: string | string[];
}

async function discoverImageUrl(parts: ChunkUrlParts): Promise<string | null> {
  const resourcePage = `https://www.loc.gov/resource/${parts.lccn}/${parts.date}/${parts.ed}/${parts.seq}/?fo=json`;
  try {
    const resp = await fetch(resourcePage, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
      },
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as LocResourceJson;

    const candidates: string[] = [];
    if (Array.isArray(json.image_url)) {
      candidates.push(...json.image_url.filter((u) => typeof u === "string"));
    } else if (typeof json.image_url === "string") {
      candidates.push(json.image_url);
    }
    for (const res of json.resources ?? []) {
      for (const f of res.files ?? []) {
        if (
          f.url &&
          (f.mimetype === "image/jpeg" || f.mimetype === "image/png") &&
          isAllowed(f.url)
        ) {
          candidates.push(f.url);
        }
      }
      if (res.url && isAllowed(res.url)) candidates.push(res.url);
    }
    for (const c of candidates) {
      if (c && isAllowed(c)) return c;
    }
    return null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");
  if (!url) return new Response("Missing url", { status: 400 });
  if (!isAllowed(url)) return new Response("URL not allowed", { status: 403 });

  const parts = extractParts(url);

  // Build ordered candidate list
  const candidates: string[] = [url];
  if (parts) {
    candidates.push(
      `https://www.loc.gov/resource/${parts.lccn}/${parts.date}/${parts.ed}/${parts.seq}.jpg`
    );
    candidates.push(
      `https://chroniclingamerica.loc.gov/lccn/${parts.lccn}/${parts.date}/${parts.ed}/${parts.seq}.jpg`
    );
  }

  for (const candidate of candidates) {
    const resp = await tryFetchImage(candidate);
    if (resp) {
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > 200) {
        return new Response(buf, {
          headers: {
            "Content-Type": resp.headers.get("Content-Type") ?? "image/jpeg",
            "Cache-Control": "public, max-age=604800, immutable",
            "X-Source-Url": candidate,
          },
        });
      }
    }
  }

  // Last resort: ask LOC's JSON metadata for the canonical image URL.
  if (parts) {
    const discovered = await discoverImageUrl(parts);
    if (discovered) {
      const resp = await tryFetchImage(discovered);
      if (resp) {
        const buf = await resp.arrayBuffer();
        if (buf.byteLength > 200) {
          return new Response(buf, {
            headers: {
              "Content-Type": resp.headers.get("Content-Type") ?? "image/jpeg",
              "Cache-Control": "public, max-age=604800, immutable",
              "X-Source-Url": discovered,
            },
          });
        }
      }
    }
  }

  return new Response("Image not available from LOC", { status: 502 });
}
