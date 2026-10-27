import { describe, expect, test } from 'bun:test'
import { featuredFor } from '../src/featured.ts'

const names = (q: string) => featuredFor(q).map((s) => s.name)

describe('featured ring sites in search', () => {
  test('the podcast, by its title or its name', () => {
    expect(names('off the record podcast')[0]).toBe('offtherecord.podcast')
    expect(names('offtherecord.podcast')[0]).toBe('offtherecord.podcast')
    expect(names('agentic coding podcast')).toContain('offtherecord.podcast')
  })
  test('every core site is found by its own name', () => {
    for (const q of ['group call', 'seo rank', 'family ancestry', 'pay agent', 'built indie', 'deadman switch', 'watch wallet', 'resident alerts', 'search peptides', 'auto hacker', 'ad network', 'live streaming', 'pics collage'])
      expect(names(q).length).toBeGreaterThan(0)
    expect(names('group call')[0]).toBe('group.call.pit.world')
    expect(names('pics collage')[0]).toBe('pics.collage')
  })
  test('by what people search for', () => {
    expect(names('family tree maker')).toContain('family.ancestry')
    expect(names('police scanner san jose')).toContain('resident.alerts')
    expect(names('free pentest')).toContain('auto.hacker')
    expect(names('conference call line')).toContain('group.call.pit.world')
  })
  test('unrelated searches get no box, and at most two', () => {
    expect(names('weather tomorrow')).toEqual([])
    expect(names('pizza near me')).toEqual([])
    expect(names('the')).toEqual([])
    expect(featuredFor('crypto wallet alerts payment link pentest family tree').length).toBeLessThanOrEqual(2)
  })
})
