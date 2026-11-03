import { createInstance as createPagefind } from '../../pagefind/pagefind.js'

// Pagefind can shorten an unknown word to a single indexed letter. Require full
// Latin terms while retaining Pagefind's Chinese segmentation and section ranking.
export function createInstance(options) {
  const index = createPagefind(options)

  async function search(query, searchOptions) {
    const text = query?.trim() || ''
    const terms = [...new Set(text.split(/\s+/u).filter(word => /^[A-Za-z0-9_]+$/.test(word)))]
    if (!terms.length || text.startsWith('"')) return index.search(query, searchOptions)
    if (terms.length === 1 && terms[0] === text) return index.search(`"${text}"`, searchOptions)

    // For several terms, keep hits in any order and reuse the combined query's excerpts.
    const [combined, ...matches] = await Promise.all([
      index.search(query, searchOptions),
      ...terms.map(term => index.search(`"${term}"`, searchOptions))
    ])
    const ids = matches.map(match => new Set(match.results.map(hit => hit.id)))
    const results = combined.results.filter(hit => ids.every(set => set.has(hit.id)))
    return { ...combined, results, unfilteredResultCount: results.length }
  }

  return { ...index, search }
}
