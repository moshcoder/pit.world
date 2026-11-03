import { retailUsd, type ShopItem } from './auction-shop.js'

/**
 * Drop-ship items for auctions.pit.world/shop, researched 2026-11-03 from US growers that ship to
 * any US address. Prices are retailUsd(cost, shipping): five times what we pay, ending in 9.
 * Re-check each supplier page (price, stock, season) before placing an order.
 */
type Source = Omit<ShopItem, 'priceUsd'>
const item = (source: Source): ShopItem => ({ ...source, priceUsd: retailUsd(source.supplier.costUsd, source.supplier.shippingUsd) })

const SWAN = 'Swan Island Dahlias'
const DAHLIA_SEASON = 'Pre-order, ships spring 2027'

export const SHOP_CATALOG: ShopItem[] = ([
  {
    slug: 'cafe-au-lait-dahlia', topic: 'dahlias', name: 'Café au Lait dahlia tuber',
    blurb: 'The wedding dahlia: 8-inch blooms that open pale peach and fade to blush, on a 4-foot plant. One tuber of the variety.',
    supplier: { name: SWAN, title: 'CAFE AU LAIT', url: 'https://dahlias.com/products/cafe-au-lait', costUsd: 29.95, shippingUsd: 12.95, shipsFrom: 'Canby, OR' },
    season: DAHLIA_SEASON,
  },
  {
    slug: 'labyrinth-dahlia', topic: 'dahlias', name: 'Labyrinth dahlia tuber',
    blurb: 'Twisting 7-inch petals in deep peach, pink and apricot on a 4-foot plant. One tuber of the variety.',
    supplier: { name: SWAN, title: 'LABYRINTH', url: 'https://dahlias.com/products/labyrinth', costUsd: 29.95, shippingUsd: 12.95, shipsFrom: 'Canby, OR' },
    season: DAHLIA_SEASON,
  },
  {
    slug: 'country-cottage-dahlias', topic: 'dahlias', name: 'Country cottage dahlia collection',
    blurb: 'Five dahlias in blush, coral and apricot: Jitterbug, Oregon Sunset, Whipper Snapper, I’m Blushing and a grower’s pick.',
    supplier: { name: SWAN, title: 'Country Cottage Bundle', url: 'https://dahlias.com/products/country-cottage-bundle', costUsd: 59.95, shippingUsd: 15.95, shipsFrom: 'Canby, OR' },
    season: DAHLIA_SEASON,
  },
  {
    slug: 'autumn-valley-dahlias', topic: 'dahlias', name: 'Autumn valley dahlia collection',
    blurb: 'Five dahlias in fall colors: Hometown Hero, Stiletto, Golden Hour, Hollyhill Black Beauty and Orange-U-Glad.',
    supplier: { name: SWAN, title: 'Autumn in the Valley Bundle', url: 'https://dahlias.com/products/autumn-in-the-valley-bundle', costUsd: 49.95, shippingUsd: 15.95, shipsFrom: 'Canby, OR' },
    season: DAHLIA_SEASON,
  },
  {
    slug: 'coffee-heirloom-mums', topic: 'mums', name: 'Coffee and fleece heirloom mums',
    blurb: 'Twelve rooted cuttings of four heirloom chrysanthemums: Mocha, Seaton’s Coffee, Bronze Fleece and Pink Fleece. Three of each.',
    supplier: { name: '3 Porch Farm', title: "Heirloom Chrysanthemum 'Mocha' + 'Seaton's Coffee' + 'Bronze Fleece' + 'Pink Fleece' (4 selections, 3 cuttings each)", url: 'https://3porchfarm.com/products/heirloom-chrysanthemum-mocha', costUsd: 66.6, shippingUsd: 15, shipsFrom: 'Comer, GA' },
    season: 'Pre-order, ships March to June 2027', restrictions: 'it cannot ship to CA, AK or HI', excludeStates: ['CA', 'AK', 'HI'], shippingEstimated: true,
  },
  {
    slug: 'fire-heirloom-mums', topic: 'mums', name: 'Fire and spider heirloom mums',
    blurb: 'Twelve rooted cuttings: Crimson Tide, Kelvin Tattoo, Vesuvio and the Coral Reef spider mum. Three of each.',
    supplier: { name: '3 Porch Farm', title: "Heirloom Chrysanthemum 'Crimson Tide' + 'Kelvin Tattoo' + 'Vesuvio' + 'Coral Reef' (4 selections, 3 cuttings each)", url: 'https://3porchfarm.com/products/heirloom-chrysanthemum-kelvin-tattoo', costUsd: 67.6, shippingUsd: 15, shipsFrom: 'Comer, GA' },
    season: 'Pre-order, ships March to June 2027', restrictions: 'it cannot ship to CA, AK or HI', excludeStates: ['CA', 'AK', 'HI'], shippingEstimated: true,
  },
  {
    slug: 'autumn-heirloom-mums', topic: 'mums', name: 'Autumn colors heirloom mums',
    blurb: 'Five heirloom chrysanthemum plugs chosen by the grower from varieties like Honey Glow, Gingernut, Mancetta Sunset and Seaton’s Ruby.',
    supplier: { name: 'Harmony Harvest Farm', title: '5-Pack Heirloom Chrysanthemum - [Autumn Colors Mix] - PREORDER', url: 'https://www.hhfshop.com/products/autumn-colors-chrysanthemum-mix', costUsd: 50, shippingUsd: 15, shipsFrom: 'Weyers Cave, VA' },
    season: 'Pre-order, ships April 2027', shippingEstimated: true,
  },
  {
    slug: 'sheffield-pink-mum', topic: 'mums', name: 'Sheffield Pink hardy mum',
    blurb: 'A hardy perennial chrysanthemum with apricot-to-pink daisies, 2 to 3 feet tall, in a 2-gallon pot. Zones 5 to 9.',
    supplier: { name: 'Almanac Planting Co', title: 'Sheffield Pink Hardy Mum (Spring ’27 pre-order, 2 gal)', url: 'https://almanacplanting.com/products/sheffield-pink-hardy-mum', costUsd: 55.95, shippingUsd: 15, shipsFrom: 'Knox, PA' },
    season: 'Pre-order, ships May to June 2027', restrictions: 'it cannot ship to CA, ID, NV, OR, TX, UT or WA', excludeStates: ['CA', 'ID', 'NV', 'OR', 'TX', 'UT', 'WA'], shippingEstimated: true,
  },
  {
    slug: 'olivia-rose-austin', topic: 'roses', name: 'Olivia Rose Austin English rose',
    blurb: 'A bare-root English shrub rose with mid-pink cupped rosettes and a light, fruity fragrance.',
    supplier: { name: 'David Austin Roses', title: 'Olivia Rose Austin (Ausmixture), bare root', url: 'https://www.davidaustinroses.com/products/olivia-rose-austin', costUsd: 40, shippingUsd: 14.95, shipsFrom: 'Tyler, TX' },
    season: 'Pre-order, ships February to May 2027', restrictions: 'it cannot ship to AK or HI', excludeStates: ['AK', 'HI'],
  },
  {
    slug: 'gertrude-jekyll-rose', topic: 'roses', name: 'Gertrude Jekyll English rose',
    blurb: 'A bare-root English shrub rose in bright pink with one of the strongest old rose fragrances.',
    supplier: { name: 'David Austin Roses', title: 'Gertrude Jekyll (Ausboard), bare root', url: 'https://www.davidaustinroses.com/products/gertrude-jekyll', costUsd: 40, shippingUsd: 14.95, shipsFrom: 'Tyler, TX' },
    season: 'Pre-order, ships February to May 2027', restrictions: 'it cannot ship to AK or HI', excludeStates: ['AK', 'HI'],
  },
  {
    slug: 'julie-andrews-rose', topic: 'roses', name: 'Julie Andrews hybrid tea rose',
    blurb: 'An own-root hybrid tea rose in a 1-gallon pot: pink blooms with a golden-yellow reverse.',
    supplier: { name: 'Heirloom Roses', title: 'Julie Andrews (1 gallon, own root)', url: 'https://www.heirloomroses.com/products/julie-andrews', costUsd: 53, shippingUsd: 19, shipsFrom: 'St. Paul, OR' },
    season: 'Ships now', restrictions: 'it cannot ship to AK, HI or US territories', excludeStates: ['AK', 'HI'],
  },
  {
    slug: 'papa-meilland-rose', topic: 'roses', name: 'Papa Meilland red rose',
    blurb: 'An own-root hybrid tea rose in a 1-gallon pot: deep velvet red with a very strong fragrance, about 3 by 3 feet.',
    supplier: { name: 'Heirloom Roses', title: 'Papa Meilland (1 gallon, own root)', url: 'https://www.heirloomroses.com/products/papa-meilland', costUsd: 58, shippingUsd: 19, shipsFrom: 'St. Paul, OR' },
    season: 'Ships now', restrictions: 'it cannot ship to AK, HI or US territories', excludeStates: ['AK', 'HI'],
  },
] satisfies Source[]).map(item)
