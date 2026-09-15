export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type TinyFishResult = {
  position: number;
  site_name: string;
  title: string;
  snippet: string;
  url: string;
};

type TinyFishResponse = {
  query: string;
  results: TinyFishResult[];
  total_results: number;
  page: number;
};

/** Real web search via TinyFish (https://docs.tinyfish.ai/search-api) — free tier, no wallet charge. */
async function searchTinyFish(query: string, limit: number): Promise<WebSearchResult[]> {
  const apiKey = process.env.TINYFISH_API_KEY;
  if (!apiKey) return [];

  const url = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) throw new Error(`TinyFish search failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as TinyFishResponse;

  return (body.results ?? []).slice(0, limit).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }));
}

type DuckDuckGoTopic = {
  Text?: string;
  FirstURL?: string;
  Topics?: DuckDuckGoTopic[];
};

type DuckDuckGoResponse = {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: DuckDuckGoTopic[];
};

function flattenTopics(topics: DuckDuckGoTopic[] | undefined, out: WebSearchResult[], limit: number) {
  if (!topics) return;
  for (const topic of topics) {
    if (out.length >= limit) return;
    if (topic.Topics) {
      flattenTopics(topic.Topics, out, limit);
    } else if (topic.FirstURL && topic.Text) {
      out.push({ title: topic.Text.split(" - ")[0] ?? topic.Text, url: topic.FirstURL, snippet: topic.Text });
    }
  }
}

/**
 * Free, no-API-key backup via DuckDuckGo's Instant Answer API. It's an instant-answer endpoint
 * rather than full search results (no general web/news crawl), so it only returns something for
 * well-known factual/encyclopedia-style queries — most everyday queries come back empty. Used
 * only when TinyFish isn't configured or fails.
 */
async function searchDuckDuckGo(query: string, limit: number): Promise<WebSearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url, { headers: { "User-Agent": "FridayAI/1.0" } });
  if (!res.ok) return [];
  const body = (await res.json()) as DuckDuckGoResponse;

  const results: WebSearchResult[] = [];
  if (body.AbstractText && body.AbstractURL) {
    results.push({ title: body.Heading || query, url: body.AbstractURL, snippet: body.AbstractText });
  }
  flattenTopics(body.RelatedTopics, results, limit);
  return results.slice(0, limit);
}

/** Tries TinyFish first (real search results), falls back to DuckDuckGo if it's unconfigured or fails. */
export async function searchWeb(query: string, limit = 5): Promise<WebSearchResult[]> {
  try {
    const tinyFishResults = await searchTinyFish(query, limit);
    if (tinyFishResults.length > 0) return tinyFishResults;
  } catch {
    /* fall through to the backup */
  }
  return searchDuckDuckGo(query, limit).catch(() => []);
}
