import * as cheerio from 'cheerio'
import type { AnyNode } from 'domhandler'

import type {
    Chapter,
    ChapterDetails,
    DiscoverSection,
    DiscoverSectionItem,
    MangaInfo,
    PagedResults,
    SearchFilter,
    SearchQuery,
    SearchResultItem,
    SourceManga,
    Tag,
    TagSection,
} from '@paperback/types'

import {
    ContentRating,
    DiscoverSectionType,
    SourceIntents,
} from '@paperback/types'

// ─── Extension Info ───────────────────────────────────────────────────────────

export const MangaKInfo = {
    version:       '1.0.0',
    name:          'MangaK',
    icon:          'icon.png',
    description:   'Extension for MangaK.io',
    contentRating: ContentRating.MATURE,
    developers:    [{ name: 'YourName', github: 'https://github.com/yourname' }],
    badges:        [],
    capabilities: [
        SourceIntents.CHAPTER_PROVIDING,
        SourceIntents.SEARCH_RESULT_PROVIDING,
        SourceIntents.DISCOVER_SECTION_PROVIDING,
    ],
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://mangak.io'

interface MangaKItem {
    slug:   string
    name:   string
    cover:  string
    status: string
}

async function fetchHTML(url: string): Promise<string> {
    const [, buffer] = await Application.scheduleRequest({
        url,
        method:  'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    return Application.arrayBufferToUTF8String(buffer)
}

function parseChapterNum(slug: string, fallback: number): number {
    // Finds last number (and optional decimal) anywhere in any slug
    // "chapter-403"                                → 403
    // "chapter-2-5"                                → 2.5
    // "side-love-on-a-deserted-island-4-the-end"  → 4
    // "notice"                                     → fallback
    const m = slug.match(/(\d+)(?:-(\d+))?(?!.*\d)/)
    return m ? parseFloat(`${m[1]!}${m[2] ? '.' + m[2] : ''}`) : fallback
}

// ─── Extension Class ──────────────────────────────────────────────────────────

export class MangaK {

    // ── Manga Details ──────────────────────────────────────────────────────────
    // mangaId = URL slug e.g. "solo-leveling"

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const html = await fetchHTML(`${BASE_URL}/${mangaId}`)
        const $    = cheerio.load(html)

        // ↓ Adjust these selectors after inspecting the title page DOM in DevTools
        const primaryTitle = $('h1.series-title, h1.entry-title').first().text().trim() || mangaId
        const thumbnailUrl = $('img.series-cover, .thumb img').first().attr('src') ?? ''
        const synopsis     = $('.series-summary, .summary__content').first().text().trim()
        const author       = $('.author-name, .artist-name').first().text().trim()
        const statusText   = $('.status, .series-status').first().text().toLowerCase()

        const genreTags: Tag[] = []
        // ↓ Adjust genre selector in DevTools
        $('.genres a, .genre-item').each((_: number, el: AnyNode) => {
            const label = $(el).text().trim()
            if (label) genreTags.push({ id: label.toLowerCase(), title: label })
        })

        const tagGroups: TagSection[] = genreTags.length
            ? [{ id: 'genres', title: 'Genres', tags: genreTags }]
            : []

        const mangaInfo: MangaInfo = {
            primaryTitle,
            secondaryTitles: [],
            thumbnailUrl,
            synopsis,
            author:        author || undefined,
            contentRating: ContentRating.MATURE,
            status:        statusText.includes('completed') ? 'Completed' : 'Ongoing',
            tagGroups,
        }

        return { mangaId, mangaInfo }
    }

    // ── Chapter List ───────────────────────────────────────────────────────────

    async getChapters(sourceManga: SourceManga, _sinceDate?: Date): Promise<Chapter[]> {
        const mangaId = sourceManga.mangaId
        const html    = await fetchHTML(`${BASE_URL}/${mangaId}`)
        const $       = cheerio.load(html)

        const chapters: Chapter[] = []

        // ↓ Adjust selector to match the actual chapter list rows in DevTools
        $('.chapter-list li, .chapters-list .wp-manga-chapter').each(
            (index: number, el: AnyNode) => {
                const anchor    = $(el).find('a').first()
                const href      = anchor.attr('href') ?? ''
                const titleText = anchor.text().trim()

                // Strip /{mangaId}/ prefix to get the raw chapter slug
                // "/eleceed/chapter-403"                           → "chapter-403"
                // "/when-the-killer.../side-love-...-4-the-end"   → "side-love-...-4-the-end"
                const chapterId = href
                    .replace(`/${mangaId}/`, '')
                    .replace(/\/$/, '')

                const chapNum = parseChapterNum(chapterId, index + 1)

                // ↓ Adjust date selector if present on the page
                const dateText    = $(el).find('.chapter-date, .chapter-time').text().trim()
                const publishDate = dateText ? new Date(dateText) : new Date()

                if (chapterId) {
                    chapters.push({
                        chapterId,
                        sourceManga,
                        langCode:     'en',
                        chapNum,
                        title:        titleText || undefined,
                        publishDate,
                        sortingIndex: index,
                    })
                }
            }
        )

        // Most sites list newest-first — reverse for ascending order
        return chapters.reverse()
    }

    // ── Chapter Details (Page Images) ──────────────────────────────────────────
    // CONFIRMED from DOM: images are in #images with plain src, no lazy loading

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const mangaId   = chapter.sourceManga.mangaId
        const chapterId = chapter.chapterId

        const html = await fetchHTML(`${BASE_URL}/${mangaId}/${chapterId}`)
        const $    = cheerio.load(html)

        const pages: string[] = []

        $('#images img').each((_: number, el: AnyNode) => {
            const src = ($(el).attr('src') ?? '').trim()
            if (src && !src.startsWith('data:')) pages.push(src)
        })

        return {
            id:      chapterId,
            mangaId: mangaId,
            pages,
        }
    }

    // ── Search ─────────────────────────────────────────────────────────────────

    async getSearchFilters(): Promise<SearchFilter[]> {
        return []
    }

    async getSearchResults(
        query: SearchQuery,
        metadata: unknown,
    ): Promise<PagedResults<SearchResultItem>> {
        const page = (metadata as { page?: number } | undefined)?.page ?? 1
        const term = encodeURIComponent(query.title ?? '')

        const html = await fetchHTML(`${BASE_URL}/search?q=${term}&page=${page}`)
        const $    = cheerio.load(html)

        const items: SearchResultItem[] = []

        // ↓ Adjust selector to match search result cards in DevTools
        $('.c-tabs-item__content, .search-results .manga-item, .c-image-hover').each(
            (_: number, el: AnyNode) => {
                const anchor   = $(el).find('a').first()
                const href     = anchor.attr('href') ?? ''
                const mangaId  = href.replace(BASE_URL, '').replace(/^\/|\/$/g, '')
                const title    = $(el).find('.post-title h3, .title').text().trim()
                const imageUrl =
                    $(el).find('img').attr('src') ??
                    $(el).find('img').attr('data-src') ??
                    ''

                if (mangaId && title) items.push({ mangaId, title, imageUrl })
            }
        )

        const hasNextPage = !!$('a.next, .nav-links .next').length

        return {
            items,
            metadata: hasNextPage ? { page: page + 1 } : undefined,
        }
    }

    // ── Discover Sections (Home Page) ──────────────────────────────────────────

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            { id: 'latest',  title: 'Latest Updates', type: DiscoverSectionType.simpleCarousel },
            { id: 'popular', title: 'Trending',        type: DiscoverSectionType.simpleCarousel },
        ]
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: unknown,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const page = (metadata as { page?: number } | undefined)?.page ?? 1
        const html = await fetchHTML(`${BASE_URL}/home`)
        const $    = cheerio.load(html)

        const items: DiscoverSectionItem[] = []

        // Parse Next.js __NEXT_DATA__ JSON — all home data is pre-loaded here
        try {
            const nextDataRaw = $('#__NEXT_DATA__').text()
            const nextData    = JSON.parse(nextDataRaw) as {
                props: {
                    pageProps: {
                        latest?:       { items: MangaKItem[]; pagination?: { has_next: boolean } }
                        popularItems?: MangaKItem[]
                    }
                }
            }
            const pp = nextData.props.pageProps

            const source: MangaKItem[] =
                section.id === 'popular'
                    ? (pp.popularItems ?? [])
                    : (pp.latest?.items ?? [])

            for (const item of source) {
                items.push({
                    type:     'simpleCarouselItem',
                    mangaId:  item.slug,
                    title:    item.name,
                    imageUrl: item.cover,
                })
            }

            const hasNext = section.id === 'latest'
                ? (pp.latest?.pagination?.has_next ?? false)
                : false

            return {
                items,
                metadata: hasNext ? { page: page + 1 } : undefined,
            }

        } catch {
            // Fallback: scrape article cards if __NEXT_DATA__ structure changes
            // ↓ Adjust selector if needed after checking the page DOM
            $('article.group').each((_: number, el: AnyNode) => {
                const anchor   = $(el).find('a').first()
                const mangaId  = (anchor.attr('href') ?? '').replace(/^\/|\/$/g, '')
                const title    = $(el).find('h3').text().trim()
                const imageUrl = $(el).find('img').attr('src') ?? ''
                if (mangaId && title) {
                    items.push({ type: 'simpleCarouselItem', mangaId, title, imageUrl })
                }
            })
            return { items, metadata: page > 1 ? { page: page + 1 } : undefined }
        }
    }
}