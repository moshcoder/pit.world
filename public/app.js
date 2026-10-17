// Optional niceties. pit.world works without this file.
// "/" focuses the search box; j/k move between results; Enter opens one.
(() => {
  const input = document.querySelector('.search input')
  const links = () => [...document.querySelectorAll('.hits .title')]
  let index = -1
  const focus = (i) => {
    const all = links()
    if (!all.length) return
    index = Math.max(0, Math.min(all.length - 1, i))
    all[index].focus()
  }
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const typing = document.activeElement === input
    if (event.key === '/' && !typing) {
      event.preventDefault()
      input?.focus()
      input?.select()
    } else if (event.key === 'Escape' && typing) {
      input.blur()
    } else if (!typing && (event.key === 'j' || event.key === 'ArrowDown')) {
      event.preventDefault()
      focus(index + 1)
    } else if (!typing && (event.key === 'k' || event.key === 'ArrowUp')) {
      event.preventDefault()
      focus(index - 1)
    }
  })
})()
