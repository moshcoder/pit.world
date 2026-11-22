/**
 * Which /pros category an imported business belongs in.
 *
 * NicheDB's directory gives a company a list of topics, and the first one used to decide its category
 * alone. That topic often says where the company was found, not what it does: a plumbing marketing
 * agency that also runs a podcast came in as "podcast" and was filed under News, media & podcasts.
 * The business's own words (its name and its homepage description) say what it does, so they count
 * most here; the topics only break a silence.
 */

/** Topics (NicheDB's industry words) to the /pros categories. First match wins; no match is no category. */
const TOPIC_RULES: Array<[RegExp, string]> = [
  [/construction|remodel|roofing|contractor/, 'construction'],
  [/real estate|property/, 'real-estate'],
  [/news|media|podcast|publishing|journalism|film|music|phonograph|broadcast|anime|video game|entertainment/, 'media'],
  [/retail|e-?commerce|deals|coupon|clothing|fashion|wholesale|shop|store|consumer goods/, 'retail'],
  [/software|ai tooling|productivity|saas|developer tools|information technology|internet service|web development|artificial intelligence/, 'software'],
  [/telecom|hosting|cloud|cyber|network|computer/, 'it'],
  [/bank|financ|insurance|invest|fintech|crypto|payment/, 'finance'],
  [/account|tax|bookkeep/, 'accounting'],
  [/law|legal/, 'legal'],
  [/pharma|biotech|health|medical|hospital|clinic|dental/, 'health'],
  [/fitness|wellness|sport/, 'wellness'],
  [/cosmetic|beauty/, 'beauty'],
  [/education|school|universit|tutor|learning/, 'education'],
  [/food|restaurant|brew|beverage|catering|hospitality|wine|coffee|bakery/, 'food'],
  [/marketing|advertising|seo\b|public relations/, 'marketing'],
  [/design|architect|creative|branding|photograph/, 'design'],
  [/consult|staffing|recruit|human resources/, 'consulting'],
  [/automotive|car |vehicle|tire/, 'auto'],
  [/industr|manufactur|energy|petroleum|oil|chemical|mechanical|electronic|battery|shipbuild|mining|steel|utility|power|aerospace/, 'industrial'],
  [/logistic|moving|storage|freight/, 'moving'],
  [/nonprofit|charity|church|religio|community/, 'community'],
  [/pet|veterinar/, 'pets'],
]

/**
 * A company with no industry leads its topics with the tech its site runs on ("google analytics",
 * "wordpress"), which says nothing about the business. A store platform is the one useful hint.
 */
const TECH = /google|tag manager|wordpress|squarespace|wix|webflow|cloudflare|netlify|vercel|next\.js|nuxt|react|vue|angular|svelte|gatsby|hugo|jekyll|ghost|framer|hubspot|amplitude|calendly|stripe|jquery|bootstrap|nginx|apache|php|typescript|javascript|mailchimp|intercom|segment|hotjar|facebook|plausible|matomo|mixpanel|sentry|recaptcha|font|cdn|aws|heroku|github|gitlab|docusaurus|astro|tailwind|elementor|yoast|drupal|joomla|typekit|zendesk|klaviyo|tiktok|linkedin|twitter|youtube|vimeo|unpkg|jsdelivr/
const STORE_TECH = /shopify|woocommerce|bigcommerce|magento|prestashop|squarespace commerce|ecwid/

/** One topic word to a category slug, or ''. */
export function categoryFor(topic: string): string {
  const t = topic.toLowerCase()
  if (STORE_TECH.test(t)) return 'retail'
  if (TECH.test(t)) return ''
  for (const [rule, slug] of TOPIC_RULES) if (rule.test(t)) return slug
  return ''
}

/**
 * What a business says about itself, per category. Word starts only (`\b`), so "seo" never matches
 * "museo". Where two categories tie, the one listed first wins.
 */
const TEXT_RULES: Array<[string, RegExp]> = [
  ['marketing', /\b(seo|search engine optimi[sz]ation|digital marketing|marketing|advertising agency|ad agency|lead generation|leads generated|ppc|pay[- ]per[- ]click|google ads|social media management|public relations|pr agency|growth agency|reputation management)/g],
  ['home-services', /\b(plumb(?:er|ers|ing)|hvac|heating and (?:air|cooling)|air condition|furnace|electricians?|handyman|house ?cleaning|cleaning services?|maid service|pest control|exterminat|locksmith|garage doors?|water heaters?|drain cleaning|septic|appliance repair|carpet cleaning|gutters?|chimney|home services|home repair)/g],
  ['construction', /\b(construction|general contractors?|contractors?|remodel|renovat|roofing|roofers?|home ?builders?|custom homes?|carpentry|flooring|drywall|concrete|masonry|cabinetry|design[- ]build)/g],
  ['outdoor', /\b(landscap|lawn|tree service|arborist|pool (?:service|cleaning|builders?)|fenc(?:e|es|ing)\b|irrigation|hardscap)/g],
  ['moving', /\b(movers|moving company|relocation services|junk removal|self[- ]storage|storage units|freight|logistics|trucking|courier)/g],
  ['auto', /\b(auto (?:repair|body|parts|service|dealer)|car (?:dealer|wash|repair|rental)|automotive|mechanic|tires\b|towing|auto detailing|collision repair)/g],
  ['legal', /\b(law firm|lawyers?|attorneys?|legal services|solicitors?|notary|immigration law|personal injury|abogad|avocats?|rechtsanw|kanzlei)/g],
  ['accounting', /\b(accounting|accountants?|bookkeep|cpa\b|tax (?:preparation|prep|returns?|services|advisors?)|payroll|steuerberat)/g],
  ['finance', /\b(venture capital|venture firm|bank\b|banking|financial (?:advis|plann|services)|wealth management|insurance|mortgages?|loans?\b|lending|investing|investment|fintech|crypto|credit union|self-directed ira|retirement planning)/g],
  ['real-estate', /\b(real estate|realtors?|realty|property management|homes for sale|apartments for rent|immobilien|inmobiliaria)/g],
  ['software', /\b(software|saas|app development|web development|developer tools|open[- ]source|artificial intelligence|machine learning|ai[- ](?:powered|agents?|platform)|api\b|no[- ]code|devops)/g],
  ['it', /\b(it services|it support|managed services|managed it|msp\b|cyber ?security|web hosting|hosting provider|cloud hosting|data cent(?:er|re)s?|computer repair|tech support|telecommunications)/g],
  ['design', /\b(graphic design|web design|branding agency|brand design|design studio|illustrat|architects?\b|architecture|arquitectura|interior design|creative agency|logo design)/g],
  ['writing', /\b(copywrit|translation services|translators?|proofread|transcription|ghostwrit|editing services)/g],
  ['photo-video', /\b(photograph|videograph|video production|wedding (?:photo|video)|event plann|event planners?|film production)/g],
  ['consulting', /\b(consulting|consultants?|consultancy|coaching|business coach|leadership development|executive search|recruiting|recruitment|staffing|human resources|management consult|advisory firm)/g],
  ['health', /\b(clinic|medical|doctors?\b|physicians?|dentist|dental|orthodont|chiropract|therapy|therapist|counsel(?:ing|ling|or)|psycholog|psychiatr|hospital|health ?care|nursing|midwi|pharmac|physiotherap|optometr)/g],
  ['wellness', /\b(fitness|gym\b|personal train|yoga|pilates|massage|nutrition|wellness|meditation|breathwork|somatic|crossfit|martial arts)/g],
  ['beauty', /\b(salons?\b|barber|nail (?:salon|studio|art)|skin ?care|day spa|beauty|cosmetic|hair (?:salon|stylist|care)|lash|makeup|tattoo)/g],
  ['education', /\b(school|universit|college|academy|tutor|tutoring|lessons|online courses?|courses\b|test prep|e-?learning|education)/g],
  ['childcare', /\b(childcare|child care|daycare|day care|preschool|nanny|babysit|elder care|senior care|in-home care)/g],
  ['pets', /\b(pets?\b|dog (?:grooming|training|walking)|groomers?|kennel|veterinar|vet clinic|animal hospital|pet sitting)/g],
  ['food', /\b(restaurant|caf[eé]\b|coffee|bakery|catering|caterers?|personal chef|brewery|brewing|winery|wines?\b|food truck|pizza|recipes?)/g],
  ['community', /\b(church|ministr(?:y|ies)|parish|mosque|synagogue|congregation|nonprofit|non-profit|charity|charitable|foundation|volunteer|gospel|bible|worship)/g],
  ['industrial', /\b(manufactur|industrial|machinery|heavy equipment|engineering services|fabricat|machining|switchgear|oil and gas|petroleum|mining|steel|chemicals?\b|aerospace|shipbuild|robotic)/g],
  ['media', /\b(news|newspaper|magazine|journalism|reporting|broadcast|radio|television|publisher|publishing|editorial|record label|noticias|diario|nachrichten|zeitung)/g],
  ['retail', /\b(online store|shop now|shop online|boutique|e-?commerce|retailer|wholesale|clothing|apparel|fashion|jewel|furniture|free shipping|gift shop|buy online)/g],
]

/** "podcast" says the site has a show, not what the business behind it does: a weak media signal only. */
const PODCAST = /\b(podcasts?|episodes?)\b/

/** A business named for SEO or marketing sells marketing, whoever its customers are ("Plumbing & HVAC SEO"). */
const MARKETING_NAME = /\b(seo|marketing|digital agency|ppc|advertising|lead gen(?:eration)?)\b/

export type ClassifyInput = { name?: string; description?: string; domain?: string; topics?: string[] }

/** Distinct matches of a rule in some text. */
function hits(rule: RegExp, text: string): number {
  if (!text) return 0
  rule.lastIndex = 0
  return new Set(text.match(rule) ?? []).size
}

/**
 * The category a business belongs in, from its name, its own description, its domain and its topics,
 * or '' when nothing says. Name words count 3, description words 1 each (at most 3 per category), the
 * first topic 2 ("podcast" only 1), so a business's own words outvote where it was found.
 */
export function classifyBusiness(input: ClassifyInput): string {
  const name = (input.name ?? '').toLowerCase()
  // Hyphenated domains read as words ("acme-plumbing.com" -> "acme plumbing com").
  const domainWords = (input.domain ?? '').toLowerCase().replace(/[.-]+/g, ' ')
  const about = `${(input.description ?? '').toLowerCase()} ${domainWords}`
  if (MARKETING_NAME.test(name) || MARKETING_NAME.test(domainWords)) return 'marketing'
  const score = new Map<string, number>()
  const add = (slug: string, n: number) => n > 0 && score.set(slug, (score.get(slug) ?? 0) + n)
  for (const [slug, rule] of TEXT_RULES) {
    add(slug, hits(rule, name) * 3)
    add(slug, Math.min(3, hits(rule, about)))
  }
  if (PODCAST.test(name) || PODCAST.test(about)) add('media', 1)
  const first = (input.topics ?? [])[0] ?? ''
  const fromTopic = categoryFor(first)
  if (fromTopic) add(fromTopic, /podcast/i.test(first) ? 1 : 2)
  let best = ''
  let top = 0
  // TEXT_RULES order breaks ties; a category only the topic named comes after them.
  const order = [...TEXT_RULES.map(([slug]) => slug), ...score.keys()]
  for (const slug of order) {
    const s = score.get(slug) ?? 0
    if (s > top) {
      best = slug
      top = s
    }
  }
  return best
}

/** Bump when the rules change: imported listings are re-categorised once (Listings.recategorizeImported). */
export const CATEGORY_RULES_VERSION = '3'
