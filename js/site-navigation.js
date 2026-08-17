(() => {
  'use strict'

  /**
   * PJAX navigation helpers for the persistent Butterfly page shell.
   *
   * The background, navigation node and shared sidebar remain mounted while
   * route-specific content is replaced and animated. Every switch keeps the
   * native Pjax callback contract so Butterfly can run its normal teardown
   * and refresh lifecycle.
   */
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const springEasing = 'cubic-bezier(.32, .72, 0, 1)'
  const fadeEasing = 'cubic-bezier(.4, 0, .2, 1)'
  const activeTransitions = new Set()
  let routeCompleteTimer = null

  const canAnimate = () => !reducedMotion.matches && typeof Element.prototype.animate === 'function'

  const waitForAnimation = animation => animation.finished.catch(() => undefined)

  /** Cancel a WAAPI animation without letting an obsolete callback escape. */
  const cancelAnimation = animation => {
    if (animation) animation.cancel()
  }

  /**
   * Resolve the scroll position that Pjax would otherwise apply only after
   * every asynchronous switch has finished. Hash routes remain Pjax-owned so
   * their target can be measured after the header reaches its final height.
   */
  const getImmediateScrollTarget = (href, options) => {
    if (options.history === false) {
      return options.scrollRestoration && Array.isArray(options.scrollPos)
        ? options.scrollPos
        : null
    }

    try {
      if (new URL(href, window.location.href).hash) return null
    } catch (_) {
      // A malformed response URL will still use the regular top position.
    }

    return [0, 0]
  }

  /** Move the document without inheriting the global smooth-scroll rule. */
  const scrollImmediately = position => {
    if (!position) return

    const root = document.documentElement
    const body = document.body
    const rootBehavior = root.style.scrollBehavior
    const bodyBehavior = body.style.scrollBehavior
    const left = Number.isFinite(Number(position[0])) ? Number(position[0]) : 0
    const top = Number.isFinite(Number(position[1])) ? Number(position[1]) : 0

    root.style.scrollBehavior = 'auto'
    body.style.scrollBehavior = 'auto'
    window.scrollTo(left, top)
    root.style.scrollBehavior = rootBehavior
    body.style.scrollBehavior = bodyBehavior
  }

  /**
   * Mobile browsers may reconcile the visual viewport one frame after a DOM
   * replacement. Re-apply a top navigation target for two frames while the
   * route is loading, without touching history restores or user scrolling.
   */
  const reconcileMobileTopScroll = position => {
    if (!position || Number(position[0]) !== 0 || Number(position[1]) !== 0) {
      return
    }

    const mobileQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 768px)')
      : null

    if (!mobileQuery?.matches) {
      return
    }

    let frameCount = 0
    const reconcile = () => {
      if (!document.documentElement.classList.contains('is-route-loading')) {
        return
      }

      if (window.scrollX !== 0 || window.scrollY !== 0) {
        scrollImmediately(position)
      }

      frameCount += 1
      if (frameCount < 3) {
        window.requestAnimationFrame(reconcile)
      }
    }

    window.requestAnimationFrame(reconcile)
  }

  /** Prepare disclosure controls before an incoming route enters the DOM. */
  const prepareIncomingRoute = route => {
    const siteMotion = window.SiteMotion

    if (!siteMotion || typeof siteMotion.prepareRouteContent !== 'function') {
      return
    }

    try {
      siteMotion.prepareRouteContent(route)
    } catch (error) {
      console.debug('Incoming route motion state could not be prepared:', error)
    }
  }

  /**
   * Track every asynchronous Pjax switch as an idempotent transaction. Pjax
   * keeps one global pending-switch counter, so a newer navigation must settle
   * the previous animations before the next response resets that counter.
   */
  const createTransition = finalize => {
    let settled = false

    const transition = {
      get settled () {
        return settled
      },
      settle () {
        if (settled) return

        settled = true
        activeTransitions.delete(transition)
        finalize()
      }
    }

    activeTransitions.add(transition)
    return transition
  }

  /** Finish the current visual state before another Pjax request can start. */
  const settleActiveTransitions = () => {
    Array.from(activeTransitions).forEach(transition => transition.settle())
  }

  /** Synchronize classes that live on persistent layout nodes. */
  const applyRouteState = state => {
    if (!state) return

    const bodyWrap = document.getElementById('body-wrap')
    const contentInner = document.getElementById('content-inner')

    if (bodyWrap && state.dataset.bodyClass) {
      bodyWrap.className = state.dataset.bodyClass
    }

    if (contentInner && state.dataset.layoutClass) {
      contentInner.className = state.dataset.layoutClass
    }

    if (state.dataset.siteConfig) {
      try {
        window.GLOBAL_CONFIG_SITE = JSON.parse(state.dataset.siteConfig)
      } catch (error) {
        console.debug('Route state config could not be parsed:', error)
      }
    }
  }

  /** Replace the state marker and immediately apply it to the persistent shell. */
  function switchRouteState (oldState, newState) {
    oldState.replaceWith(newState)
    applyRouteState(newState)
    this.onSwitch()
  }

  /**
   * Replace the page header while transplanting the existing navigation node.
   * The header height interpolates between home, page and article layouts.
   */
  function switchHeader (oldHeader, newHeader) {
    const finishSwitch = this.onSwitch.bind(this)
    const currentNav = oldHeader.querySelector('#nav')
    const incomingNav = newHeader.querySelector('#nav')
    const oldHeight = oldHeader.getBoundingClientRect().height

    if (currentNav && incomingNav) {
      incomingNav.replaceWith(currentNav)
    }

    oldHeader.replaceWith(newHeader)

    if (!canAnimate()) {
      finishSwitch()
      return
    }

    const targetHeight = newHeader.getBoundingClientRect().height
    const duration = Math.min(460, 320 + Math.abs(targetHeight - oldHeight) * 0.12)
    const headerContent = Array.from(newHeader.children).filter(element => element.id !== 'nav')

    newHeader.style.height = `${oldHeight}px`
    newHeader.style.overflow = 'hidden'

    let heightAnimation = null
    let contentAnimations = []
    const transition = createTransition(() => {
      newHeader.style.removeProperty('height')
      newHeader.style.removeProperty('overflow')
      cancelAnimation(heightAnimation)
      contentAnimations.forEach(cancelAnimation)
      finishSwitch()
    })

    heightAnimation = newHeader.animate(
      [
        { height: `${oldHeight}px` },
        { height: `${targetHeight}px` }
      ],
      {
        duration,
        easing: springEasing,
        fill: 'both'
      }
    )

    contentAnimations = headerContent.map((element, index) => element.animate(
      [
        { opacity: 0, transform: 'translate3d(0, 10px, 0)' },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' }
      ],
      {
        duration: 280,
        delay: 35 + index * 20,
        easing: springEasing,
        fill: 'both'
      }
    ))

    Promise.all([
      waitForAnimation(heightAnimation),
      ...contentAnimations.map(waitForAnimation)
    ]).finally(() => transition.settle())
  }

  /**
   * Cross-fade the route body without moving the persistent sidebar. The old
   * view is temporarily taken out of flex layout so both views can overlap.
   */
  function switchRouteContent (oldContent, newContent, options = {}) {
    const finishSwitch = this.onSwitch.bind(this)
    const immediateScrollTarget = getImmediateScrollTarget(this.state.href, options)

    if (!canAnimate()) {
      oldContent.replaceWith(newContent)
      scrollImmediately(immediateScrollTarget)
      finishSwitch()
      return
    }

    const parent = oldContent.parentElement
    const oldRect = oldContent.getBoundingClientRect()
    const direction = options.backward ? -1 : 1
    // Normal forward navigation is immediately moved to the new route's top.
    // Keeping the old node fixed at its previous viewport coordinate exposes
    // the old mobile viewport during the first frames, especially when the
    // address bar changes the visual viewport height. Only history restores
    // with a non-zero saved position need the fixed presentation.
    const holdOutgoingInViewport = Boolean(
      immediateScrollTarget &&
      (Number(immediateScrollTarget[0]) !== 0 || Number(immediateScrollTarget[1]) !== 0),
    )
    const oldOffsetTop = oldContent.offsetTop
    const oldOffsetLeft = oldContent.offsetLeft

    Object.assign(oldContent.style, {
      position: holdOutgoingInViewport ? 'fixed' : 'absolute',
      top: `${holdOutgoingInViewport ? oldRect.top : oldOffsetTop}px`,
      left: `${holdOutgoingInViewport ? oldRect.left : oldOffsetLeft}px`,
      width: `${oldRect.width}px`,
      zIndex: '2',
      pointerEvents: 'none'
    })
    oldContent.removeAttribute('id')
    oldContent.classList.add('route-content--leaving')
    oldContent.setAttribute('aria-hidden', 'true')
    prepareIncomingRoute(newContent)
    parent.insertBefore(newContent, oldContent)
    scrollImmediately(immediateScrollTarget)
    reconcileMobileTopScroll(immediateScrollTarget)

    let outgoing = null
    let incoming = null
    const transition = createTransition(() => {
      oldContent.remove()
      cancelAnimation(outgoing)
      cancelAnimation(incoming)
      finishSwitch()
    })

    outgoing = oldContent.animate(
      [
        { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
        { opacity: 0, transform: `translate3d(${-10 * direction}px, -4px, 0) scale(.992)` }
      ],
      {
        duration: 220,
        easing: fadeEasing,
        fill: 'both'
      }
    )

    incoming = newContent.animate(
      [
        { opacity: 0, transform: `translate3d(${12 * direction}px, 8px, 0) scale(.994)` },
        { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' }
      ],
      {
        duration: 360,
        easing: springEasing,
        fill: 'both'
      }
    )

    Promise.all([
      waitForAnimation(outgoing),
      waitForAnimation(incoming)
    ]).finally(() => transition.settle())
  }

  /**
   * Keep the identical hub-page sidebar mounted. Article routes receive their
   * own TOC sidebar and use a short sequential cross-fade.
   */
  function switchAside (oldAside, newAside) {
    const finishSwitch = this.onSwitch.bind(this)
    const keepSharedAside = oldAside.dataset.routeScope === 'shared' && newAside.dataset.routeScope === 'shared'

    if (keepSharedAside) {
      finishSwitch()
      return
    }

    if (!canAnimate()) {
      oldAside.replaceWith(newAside)
      finishSwitch()
      return
    }

    let outgoing = null
    let incoming = null
    let incomingMounted = false
    const transition = createTransition(() => {
      cancelAnimation(outgoing)
      cancelAnimation(incoming)

      if (!incomingMounted) {
        oldAside.replaceWith(newAside)
        incomingMounted = true
      }

      finishSwitch()
    })

    outgoing = oldAside.animate(
      [
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        { opacity: 0, transform: 'translate3d(8px, 0, 0)' }
      ],
      {
        duration: 140,
        easing: fadeEasing,
        fill: 'both'
      }
    )

    waitForAnimation(outgoing).then(() => {
      if (transition.settled) return

      oldAside.replaceWith(newAside)
      incomingMounted = true
      cancelAnimation(outgoing)

      incoming = newAside.animate(
        [
          { opacity: 0, transform: 'translate3d(8px, 0, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' }
        ],
        {
          duration: 240,
          easing: springEasing,
          fill: 'both'
        }
      )

      waitForAnimation(incoming).finally(() => transition.settle())
    })
  }

  /** Resolve nested archive, tag and category URLs to their primary nav item. */
  const activeRouteFor = pathname => {
    const normalized = pathname.replace(/\/{2,}/g, '/').replace(/\/?$/, '/')
    const primaryRoutes = ['/about/', '/archives/', '/tags/', '/categories/', '/friends/']
    return primaryRoutes.find(route => normalized.startsWith(route)) || (normalized === '/' ? '/' : '')
  }

  /** Update desktop and mobile navigation without replacing either menu. */
  const markActiveNavigation = () => {
    const activeRoute = activeRouteFor(window.location.pathname)
    const links = document.querySelectorAll('#nav a.site-page[href], #sidebar-menus a.site-page[href]')

    links.forEach(link => {
      let linkPath = ''
      try {
        linkPath = new URL(link.href, window.location.href).pathname.replace(/\/?$/, '/')
      } catch (_) {
        return
      }

      const isActive = Boolean(activeRoute) && linkPath === activeRoute
      link.classList.toggle('is-active', isActive)
      if (isActive) {
        link.setAttribute('aria-current', 'page')
      } else {
        link.removeAttribute('aria-current')
      }
    })
  }

  /** Install route feedback once; page-specific listeners remain Butterfly-owned. */
  const bindNavigationLifecycle = () => {
    document.addEventListener('pjax:send', () => {
      settleActiveTransitions()
      window.clearTimeout(routeCompleteTimer)
      document.documentElement.classList.remove('is-route-complete')
      document.documentElement.classList.add('is-route-loading')
    })

    const finishNavigation = () => {
      document.documentElement.classList.remove('is-route-loading')
      document.documentElement.classList.add('is-route-complete')
      window.clearTimeout(routeCompleteTimer)
      routeCompleteTimer = window.setTimeout(() => {
        document.documentElement.classList.remove('is-route-complete')
      }, 240)
      markActiveNavigation()
    }

    document.addEventListener('pjax:complete', finishNavigation)
    document.addEventListener('pjax:error', finishNavigation)
    window.addEventListener('pageshow', markActiveNavigation)

    const settleForReducedMotion = event => {
      if (event.matches) settleActiveTransitions()
    }

    if (typeof reducedMotion.addEventListener === 'function') {
      reducedMotion.addEventListener('change', settleForReducedMotion)
    } else if (typeof reducedMotion.addListener === 'function') {
      reducedMotion.addListener(settleForReducedMotion)
    }

    applyRouteState(document.getElementById('route-state'))
    markActiveNavigation()
  }

  window.SiteNavigation = Object.freeze({
    applyRouteState,
    markActiveNavigation,
    switches: Object.freeze({
      '#route-state': switchRouteState,
      '#page-header': switchHeader,
      '#route-content': switchRouteContent,
      '#aside-content': switchAside
    })
  })

  bindNavigationLifecycle()
})()
