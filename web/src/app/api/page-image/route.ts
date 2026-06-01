import { NextRequest } from "next/server";

const ALLOWED_PREFIXES = [
  "https://www.loc.gov/",
  "https://chroniclingamerica.loc.gov/",
  "https://tile.loc.gov/",
];

function urlVariants(original: string): string[] {
  const variants = new Set<string>([original]);

  // chroniclingamerica.loc.gov/lccn/X/DATE/ed-N/seq-N.jpg →
  // www.loc.gov/resource/X/DATE/ed-N/seq-N.jpg
  const legacyMatch = original.match(
    /^https:\/\/chroniclingamerica\.loc\.gov\/lccn\/([^/]+)\/([^/]+)\/(ed-\d+)\/(seq-\d+)\.(jpg|jp2|pdf)$/
  );
  if (legacyMatch) {
    const [, lccn, d, ed, seq, ext] = legacyMatch;
    variants.add(`https://www.loc.gov/resource/${lccn}/${d}/${ed}/${seq}.${ext}`);
    // Also try newer JSON resource endpoint variant
    if (ext === "jpg") {
      variants.add(
        `https://www.loc.gov/resource/${lccn}/${d}/${ed}/${seq}/?st=image&fo=image`
      );
    }
  }

  // www.loc.gov/resource/... → chroniclingamerica.loc.gov/lccn/...
  const newMatch = original.match(
    /^https:\/\/www\.loc\.gov\/resource\/([^/]+)\/([^/]+)\/(ed-\d+)\/(seq-\d+)\.(jpg|jp2|pdf)$/
  );
  if (newMatch) {
    const [, lccn, d, ed, seq, ext] = newMatch;
    variants.add(`https://chroniclingamerica.loc.gov/lccn/${lccn}/${d}/${ed}/${seq}.${ext}`);
  }

  return Array.from(variants);
}

function isAllowed(url: string): boolean {
  return ALLOWED_PREFIXES.some((p) => url.startsWith(p));
}

const UA = "Herald/0.1 (mailto:timhartnett29@gmail.com; +https://github.com/HistorySims/herald)";

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");
  if (!url) {
    return new Response("Missing url", { status: 400 });
  }
  if (!isAllowed(url)) {
    return new Response("URL not allowed", { status: 403 });
  }

  const candidates = urlVariants(url);

  for (const candidate of candidates) {
    try {
      const resp = await fetch(candidate, {
        headers: {
          "User-Agent": UA,
          Accept: "image/jpeg, image/png, image/*, */*",
        },
        redirect: "follow",
      });
      if (!resp.ok) continue;
      const ct = resp.headers.get("Content-Type") ?? "";
      if (!ct.startsWith("image/")) continue;
      const buf = await resp.arrayBuffer();
      if (buf.byteLength < 200) continue;
      return new Response(buf, {
        headers: {
          "Content-Type": ct,
          "Cache-Control": "public, max-age=604800, immutable",
          "X-Source-Url": candidate,
        },
      });
    } catch {
      // try next variant
    }
  }

  return new Response("Image not available from LOC", { status: 502 });
}
