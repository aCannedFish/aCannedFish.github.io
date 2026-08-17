document.addEventListener('DOMContentLoaded', () => {
  let headerContentWidth, $nav
  let mobileSidebarOpen = false
  let disposeScrollHandlers = null
  let disposeTocHandlers = null
  let mobileTocTransition = null
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  const codeMotionStates = new WeakMap()
  const activeCodeFigures = new Set()

  /**
   * 将高频事件合并到下一次浏览器绘制，避免同一帧内重复读写布局。
   * 返回的调度函数带有 cancel 方法，供 PJAX 切换前取消未执行的回调。
   */
  const createFrameScheduler = callback => {
    let frameId = null
    let latestArgs = []

    const schedule = (...args) => {
      latestArgs = args
      if (frameId !== null) return

      frameId = window.requestAnimationFrame(() => {
        const callbackArgs = latestArgs
        frameId = null
        latestArgs = []
        callback(...callbackArgs)
      })
    }

    schedule.cancel = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId)
      frameId = null
      latestArgs = []
    }

    return schedule
  }

  /**
   * 清理移动目录的临时过渡。重复点击保留当前样式以支持顺畅反向过渡，
   * PJAX 切换和过渡结束时则恢复由样式表管理的默认值。
   */
  const clearMobileTocTransition = (resetStyles = true) => {
    if (!mobileTocTransition) return

    const { element, onTransitionEnd } = mobileTocTransition
    element.removeEventListener('transitionend', onTransitionEnd)
    element.removeEventListener('transitioncancel', onTransitionEnd)

    if (resetStyles) {
      element.style.removeProperty('transition')
      element.style.removeProperty('transform-origin')
    }

    mobileTocTransition = null
  }

  /** 获取代码块的持久动画状态，供快速反向与 PJAX 清理复用。 */
  const getCodeMotionState = figure => {
    let state = codeMotionStates.get(figure)

    if (!state) {
      state = {
        animation: null,
        inlineStyles: null,
        limitButton: null,
        limitExpanded: false,
        motionId: 0,
        motionType: null,
        toolbar: null,
        toolbarClosed: false
      }
      codeMotionStates.set(figure, state)
    }

    return state
  }

  /** 同步代码折叠控件的最终类名与辅助状态。 */
  const commitCodeMotionState = state => {
    if (state.toolbar) {
      state.toolbar.classList.toggle('closed', state.toolbarClosed)
      state.toolbar.classList.remove('is-collapsing')
      state.toolbar.querySelector('.expand')?.setAttribute('aria-expanded', String(!state.toolbarClosed))
    }

    if (state.limitButton) {
      state.limitButton.classList.toggle('expand-done', state.limitExpanded)
      state.limitButton.classList.remove('is-collapsing')
      state.limitButton.setAttribute('aria-expanded', String(state.limitExpanded))
    }
  }

  /** 恢复动画前已有的行内样式，避免覆盖文章或插件的自定义值。 */
  const restoreCodeInlineStyles = (figure, state) => {
    if (!state.inlineStyles) return

    figure.style.height = state.inlineStyles.height
    figure.style.overflow = state.inlineStyles.overflow
    figure.style.willChange = state.inlineStyles.willChange
    state.inlineStyles = null
  }

  /** 将进行中的代码块动画立即落到其目标状态。 */
  const settleCodeMotion = figure => {
    const state = codeMotionStates.get(figure)
    if (!state) return

    state.motionId += 1
    const animation = state.animation
    state.animation = null
    animation?.cancel()
    commitCodeMotionState(state)
    restoreCodeInlineStyles(figure, state)
    state.motionType = null
    activeCodeFigures.delete(figure)
  }

  /**
   * 固定当前视觉高度并中断旧动画。不同控件同时操作时先提交旧状态，
   * 同一控件连续点击则从当前帧自然反向。
   */
  const prepareCodeMotion = (figure, state, motionType) => {
    if (state.animation && state.motionType !== motionType) settleCodeMotion(figure)

    const startHeight = figure.getBoundingClientRect().height
    state.motionId += 1
    const motionId = state.motionId
    const previousAnimation = state.animation
    state.animation = null
    previousAnimation?.cancel()

    if (!state.inlineStyles) {
      state.inlineStyles = {
        height: figure.style.height,
        overflow: figure.style.overflow,
        willChange: figure.style.willChange
      }
    }

    state.motionType = motionType
    return { motionId, startHeight }
  }

  /** 使用 WAAPI 在当前高度与测量后的目标高度之间过渡。 */
  const animateCodeHeight = (figure, state, startHeight, targetHeight, motionId) => {
    figure.style.height = `${startHeight}px`
    figure.style.overflow = 'hidden'
    figure.style.willChange = 'height'
    activeCodeFigures.add(figure)

    const finish = () => {
      if (state.motionId !== motionId) return

      const animation = state.animation
      state.animation = null
      commitCodeMotionState(state)
      restoreCodeInlineStyles(figure, state)
      state.motionType = null
      activeCodeFigures.delete(figure)
      animation?.cancel()
    }

    if (reducedMotionQuery.matches || typeof figure.animate !== 'function' || Math.abs(targetHeight - startHeight) < 1) {
      finish()
      return
    }

    const distance = Math.abs(targetHeight - startHeight)
    const duration = Math.min(400, Math.max(180, 190 + distance * 0.06))

    try {
      const animation = figure.animate(
        [
          { height: `${startHeight}px` },
          { height: `${targetHeight}px` }
        ],
        {
          duration,
          easing: 'cubic-bezier(.32, .72, 0, 1)',
          fill: 'both'
        }
      )

      state.animation = animation
      animation.finished.then(finish).catch(() => undefined)
    } catch (error) {
      console.debug('Code block motion could not start:', error)
      finish()
    }
  }

  /** 切换工具栏折叠状态，收起期间保留正文并由 figure 高度裁切。 */
  const setHighlightCollapsed = (toolbar, collapsed) => {
    const figure = toolbar.closest('figure.highlight')
    if (!figure) return

    const state = getCodeMotionState(figure)
    if (state.toolbarClosed === collapsed && !state.animation) return

    const { motionId, startHeight } = prepareCodeMotion(figure, state, 'toolbar')
    state.toolbar = toolbar
    state.toolbarClosed = collapsed

    toolbar.classList.remove('closed')
    toolbar.classList.toggle('is-collapsing', collapsed)
    toolbar.querySelector('.expand')?.setAttribute('aria-expanded', String(!collapsed))

    figure.style.height = 'auto'
    const expandedHeight = figure.scrollHeight
    const targetHeight = collapsed ? toolbar.getBoundingClientRect().height : expandedHeight
    animateCodeHeight(figure, state, startHeight, targetHeight, motionId)
  }

  /** 切换高度限制状态；当前配置关闭此功能，但保持主题能力平滑可用。 */
  const setCodeLimitExpanded = (button, expanded) => {
    const figure = button.closest('figure.highlight')
    if (!figure) return

    const state = getCodeMotionState(figure)
    if (state.limitExpanded === expanded && !state.animation) return

    const { motionId, startHeight } = prepareCodeMotion(figure, state, 'limit')
    state.limitButton = button
    state.limitExpanded = expanded

    button.classList.toggle('expand-done', expanded)
    button.classList.remove('is-collapsing')
    figure.style.height = 'auto'
    const targetHeight = figure.scrollHeight

    if (!expanded) {
      button.classList.add('expand-done', 'is-collapsing')
    }

    button.setAttribute('aria-expanded', String(expanded))
    animateCodeHeight(figure, state, startHeight, targetHeight, motionId)
  }

  /** 初始化新插入代码块的状态与键盘语义。 */
  const initializeCodeMotion = figure => {
    const state = getCodeMotionState(figure)
    state.toolbar = figure.querySelector('.highlight-tools')
    state.limitButton = figure.querySelector('.code-expand-btn')
    state.toolbarClosed = Boolean(state.toolbar?.classList.contains('closed'))
    state.limitExpanded = Boolean(state.limitButton?.classList.contains('expand-done'))

    const expandIcon = state.toolbar?.querySelector('.expand')
    if (expandIcon) {
      expandIcon.setAttribute('role', 'button')
      expandIcon.setAttribute('tabindex', '0')
      expandIcon.setAttribute('aria-label', '展开或折叠代码')
    }

    if (state.limitButton) {
      state.limitButton.setAttribute('role', 'button')
      state.limitButton.setAttribute('tabindex', '0')
      state.limitButton.setAttribute('aria-label', '展开或收起长代码')
    }

    commitCodeMotionState(state)
  }

  /** 清理代码动画和全屏滚动锁，供 PJAX 离开文章前调用。 */
  const cleanupCodeMotion = () => {
    Array.from(activeCodeFigures).forEach(settleCodeMotion)
    const fullpageFigures = document.querySelectorAll('figure.highlight.code-fullpage')
    if (fullpageFigures.length) {
      fullpageFigures.forEach(figure => figure.classList.remove('code-fullpage'))
      document.body.style.overflow = ''
    }
  }

  const handleReducedCodeMotion = event => {
    if (event.matches) Array.from(activeCodeFigures).forEach(settleCodeMotion)
  }

  if (typeof reducedMotionQuery.addEventListener === 'function') {
    reducedMotionQuery.addEventListener('change', handleReducedCodeMotion)
  } else if (typeof reducedMotionQuery.addListener === 'function') {
    reducedMotionQuery.addListener(handleReducedCodeMotion)
  }

  const adjustMenu = init => {
    const getAllWidth = ele => Array.from(ele).reduce((width, i) => width + i.offsetWidth, 0)

    if (init) {
      const blogInfoWidth = getAllWidth(document.querySelector('#blog-info > a').children)
      const menusWidth = getAllWidth(document.getElementById('menus').children)
      headerContentWidth = blogInfoWidth + menusWidth
      $nav = document.getElementById('nav')
    }

    const hideMenuIndex = window.innerWidth <= 768 || headerContentWidth > $nav.offsetWidth - 120
    $nav.classList.toggle('hide-menu', hideMenuIndex)
  }

  // 初始化header
  const initAdjust = () => {
    adjustMenu(true)
    $nav.classList.add('show')
  }

  // sidebar menus
  const sidebarFn = {
    open: () => {
      btf.overflowPaddingR.add()
      document.getElementById('menu-mask').classList.add('open')
      document.getElementById('sidebar-menus').classList.add('open')
      mobileSidebarOpen = true
    },
    close: () => {
      btf.overflowPaddingR.remove()
      document.getElementById('menu-mask').classList.remove('open')
      document.getElementById('sidebar-menus').classList.remove('open')
      mobileSidebarOpen = false
    }
  }

  // 移动导航属于持久外壳，PJAX 切页时主动收起并解除页面滚动锁。
  btf.addGlobalFn('pjaxSend', () => {
    if (mobileSidebarOpen) sidebarFn.close()
  }, 'closeMobileSidebar')

  /**
   * 首頁top_img底下的箭頭
   */
  const scrollDownInIndex = () => {
    const handleScrollToDest = () => {
      btf.scrollToDest(document.getElementById('content-inner').offsetTop, 300)
    }

    const $scrollDownEle = document.getElementById('scroll-down')
    $scrollDownEle && btf.addEventListenerPjax($scrollDownEle, 'click', handleScrollToDest)
  }

  /**
   * 代碼
   * 只適用於Hexo默認的代碼渲染
   */
  const addHighlightTool = () => {
    const highLight = GLOBAL_CONFIG.highlight
    if (!highLight) return

    const { highlightCopy, highlightLang, highlightHeightLimit, highlightFullpage, highlightMacStyle, plugin } = highLight
    const isHighlightShrink = GLOBAL_CONFIG_SITE.isHighlightShrink
    const isShowTool = highlightCopy || highlightLang || isHighlightShrink !== undefined || highlightFullpage || highlightMacStyle
    const isNotHighlightJs = plugin !== 'highlight.js'
    const isPrismjs = plugin === 'prismjs'
    const $figureHighlight = isNotHighlightJs
      ? Array.from(document.querySelectorAll('code[class*="language-"]')).map(code => code.parentElement)
      : document.querySelectorAll('figure.highlight')

    if (!((isShowTool || highlightHeightLimit) && $figureHighlight.length)) return

    const highlightShrinkClass = isHighlightShrink === true ? 'closed' : ''
    const highlightShrinkEle = isHighlightShrink !== undefined ? '<i class="fas fa-angle-down expand"></i>' : ''
    const highlightCopyEle = highlightCopy ? '<i class="fas fa-paste copy-button"></i>' : ''
    const highlightMacStyleEle = '<div class="macStyle"><div class="mac-close"></div><div class="mac-minimize"></div><div class="mac-maximize"></div></div>'
    const highlightFullpageEle = highlightFullpage ? '<i class="fa-solid fa-up-right-and-down-left-from-center fullpage-button"></i>' : ''

    const alertInfo = (ele, text) => {
      if (GLOBAL_CONFIG.Snackbar !== undefined) {
        btf.snackbarShow(text)
      } else {
        const newEle = document.createElement('div')
        newEle.className = 'copy-notice'
        newEle.textContent = text
        document.body.appendChild(newEle)

        const buttonRect = ele.getBoundingClientRect()
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft

        // X-axis boundary check
        const halfWidth = newEle.offsetWidth / 2
        const centerLeft = buttonRect.left + scrollLeft + buttonRect.width / 2
        const finalLeft = Math.max(halfWidth + 10, Math.min(window.innerWidth - halfWidth - 10, centerLeft))

        // Show tooltip below button if too close to top
        const normalTop = buttonRect.top + scrollTop - 40
        const shouldShowBelow = buttonRect.top < 60 || normalTop < 10

        const topValue = shouldShowBelow ? buttonRect.top + scrollTop + buttonRect.height + 10 : normalTop

        newEle.style.cssText = `
      top: ${topValue + 10}px;
      left: ${finalLeft}px;
      transform: translateX(-50%);
      opacity: 0;
      transition: opacity 0.3s ease, top 0.3s ease;
    `

        requestAnimationFrame(() => {
          newEle.style.opacity = '1'
          newEle.style.top = `${topValue}px`
        })

        setTimeout(() => {
          newEle.style.opacity = '0'
          newEle.style.top = `${topValue + 10}px`
          setTimeout(() => {
            newEle?.remove()
          }, 300)
        }, 800)
      }
    }

    const copy = async (text, ctx) => {
      try {
        await navigator.clipboard.writeText(text)
        alertInfo(ctx, GLOBAL_CONFIG.copy.success)
      } catch (err) {
        console.error('Failed to copy: ', err)
        alertInfo(ctx, GLOBAL_CONFIG.copy.noSupport)
      }
    }

    // click events
    const highlightCopyFn = (ele, clickEle) => {
      const $buttonParent = ele.parentNode
      $buttonParent.classList.add('copy-true')
      const preCodeSelector = isNotHighlightJs ? 'pre code' : 'table .code pre'
      const codeElement = $buttonParent.querySelector(preCodeSelector)
      if (!codeElement) return
      copy(codeElement.innerText, clickEle)
      $buttonParent.classList.remove('copy-true')
    }

    const highlightShrinkFn = toolbar => {
      const figure = toolbar.closest('figure.highlight')
      if (!figure) return

      const state = getCodeMotionState(figure)
      setHighlightCollapsed(toolbar, !state.toolbarClosed)
    }

    const codeFullpage = (item, clickEle) => {
      const wrapEle = item.closest('figure.highlight')
      settleCodeMotion(wrapEle)
      const isFullpage = wrapEle.classList.toggle('code-fullpage')

      document.body.style.overflow = isFullpage ? 'hidden' : ''
      clickEle.classList.toggle('fa-down-left-and-up-right-to-center', isFullpage)
      clickEle.classList.toggle('fa-up-right-and-down-left-from-center', !isFullpage)
    }

    const highlightToolsFn = e => {
      const action = e.target.closest('.expand, .copy-button, .fullpage-button')
      const currentElement = e.currentTarget
      if (!action || !currentElement.contains(action)) return

      if (action.classList.contains('expand')) highlightShrinkFn(currentElement)
      else if (action.classList.contains('copy-button')) highlightCopyFn(currentElement, action)
      else if (action.classList.contains('fullpage-button')) codeFullpage(currentElement, action)
    }

    const highlightToolsKeydownFn = e => {
      if (!e.target.classList.contains('expand') || !['Enter', ' '].includes(e.key)) return

      e.preventDefault()
      highlightShrinkFn(e.currentTarget)
    }

    const expandCode = e => {
      const button = e.currentTarget
      const figure = button.closest('figure.highlight')
      if (!figure) return

      const state = getCodeMotionState(figure)
      setCodeLimitExpanded(button, !state.limitExpanded)
    }

    const expandCodeKeydown = e => {
      if (!['Enter', ' '].includes(e.key)) return

      e.preventDefault()
      expandCode(e)
    }

    // 獲取隱藏狀態下元素的真實高度
    const getActualHeight = item => {
      if (item.offsetHeight > 0) return item.offsetHeight
      const hiddenElements = new Map()

      const fix = () => {
        let current = item
        while (current !== document.body && current != null) {
          if (window.getComputedStyle(current).display === 'none') {
            hiddenElements.set(current, current.getAttribute('style') || '')
          }
          current = current.parentNode
        }

        const style = 'visibility: hidden !important; display: block !important;'
        hiddenElements.forEach((originalStyle, elem) => {
          elem.setAttribute('style', originalStyle ? originalStyle + ';' + style : style)
        })
      }

      const restore = () => {
        hiddenElements.forEach((originalStyle, elem) => {
          if (originalStyle === '') elem.removeAttribute('style')
          else elem.setAttribute('style', originalStyle)
        })
      }

      fix()
      const height = item.offsetHeight
      restore()
      return height
    }

    const createEle = (lang, item) => {
      const fragment = document.createDocumentFragment()
      let hlTools = null
      let codeExpandButton = null

      if (isShowTool) {
        hlTools = document.createElement('div')
        hlTools.className = `highlight-tools ${highlightShrinkClass}`
        hlTools.innerHTML = highlightMacStyleEle + highlightShrinkEle + lang + highlightCopyEle + highlightFullpageEle
        btf.addEventListenerPjax(hlTools, 'click', highlightToolsFn)
        btf.addEventListenerPjax(hlTools, 'keydown', highlightToolsKeydownFn)
        fragment.appendChild(hlTools)
      }

      if (highlightHeightLimit && getActualHeight(item) > highlightHeightLimit + 30) {
        codeExpandButton = document.createElement('div')
        codeExpandButton.className = 'code-expand-btn'
        codeExpandButton.innerHTML = '<i class="fas fa-angle-double-down"></i>'
        btf.addEventListenerPjax(codeExpandButton, 'click', expandCode)
        btf.addEventListenerPjax(codeExpandButton, 'keydown', expandCodeKeydown)
        fragment.appendChild(codeExpandButton)
      }

      isNotHighlightJs ? item.parentNode.insertBefore(fragment, item) : item.insertBefore(fragment, item.firstChild)
      const figure = isNotHighlightJs ? item.parentElement : item
      if (hlTools || codeExpandButton) initializeCodeMotion(figure)
    }

    $figureHighlight.forEach(item => {
      if (item.dataset.highlightToolsReady === 'true') return
      item.dataset.highlightToolsReady = 'true'

      let langName = ''
      if (isNotHighlightJs) {
        const newClassName = isPrismjs ? 'prismjs' : 'default'
        btf.wrap(item, 'figure', { class: `highlight ${newClassName}` })
      }

      if (!highlightLang) {
        createEle('', item)
        return
      }

      if (isNotHighlightJs) {
        langName = isPrismjs ? item.getAttribute('data-language') || 'Code' : item.querySelector('code').getAttribute('class').replace('language-', '')
      } else {
        langName = item.getAttribute('class').split(' ')[1]
        if (langName === 'plain' || langName === undefined) langName = 'Code'
      }
      createEle(`<div class="code-lang">${langName}</div>`, item)
    })

    btf.addGlobalFn('pjaxSendOnce', cleanupCodeMotion, 'highlightMotionCleanup')
  }

  /**
   * PhotoFigcaption
   */
  const addPhotoFigcaption = () => {
    if (!GLOBAL_CONFIG.isPhotoFigcaption) return
    document.querySelectorAll('#article-container img').forEach(item => {
      const altValue = item.title || item.alt
      if (!altValue) return
      const ele = document.createElement('div')
      ele.className = 'img-alt text-center'
      ele.textContent = altValue
      item.insertAdjacentElement('afterend', ele)
    })
  }

  /**
   * Lightbox
   */
  const runLightbox = () => {
    btf.loadLightbox(document.querySelectorAll('#article-container img:not(.no-lightbox)'))
  }

  /**
   * justified-gallery 圖庫排版
   */

  const fetchUrl = async url => {
    try {
      const response = await fetch(url)
      return await response.json()
    } catch (error) {
      console.error('Failed to fetch URL:', error)
      return []
    }
  }

  const runJustifiedGallery = (container, data, config) => {
    const { isButton, limit, firstLimit, tabs } = config

    const dataLength = data.length
    const maxGroupKey = Math.ceil((dataLength - firstLimit) / limit + 1)

    // Gallery configuration
    const igConfig = {
      gap: 5,
      isConstantSize: true,
      sizeRange: [150, 600],
      // useResizeObserver: true,
      // observeChildren: true,
      useTransform: true
      // useRecycle: false
    }

    const ig = new InfiniteGrid.JustifiedInfiniteGrid(container, igConfig)
    let isLayoutHidden = false

    // Utility functions
    const sanitizeString = str => (str && str.replace(/"/g, '&quot;')) || ''

    const createImageItem = item => {
      const alt = item.alt ? `alt="${sanitizeString(item.alt)}"` : ''
      const title = item.title ? `title="${sanitizeString(item.title)}"` : ''
      return `<div class="item">
        <img src="${item.url}" data-grid-maintained-target="true" ${alt} ${title} />
      </div>`
    }

    const getItems = (nextGroupKey, count, isFirst = false) => {
      const startIndex = isFirst ? (nextGroupKey - 1) * count : (nextGroupKey - 2) * count + firstLimit
      return data.slice(startIndex, startIndex + count).map(createImageItem)
    }

    // Load more button
    const addLoadMoreButton = container => {
      const button = document.createElement('button')
      button.innerHTML = `${GLOBAL_CONFIG.infinitegrid.buttonText}<i class="fa-solid fa-arrow-down"></i>`

      button.addEventListener('click', () => {
        button.remove()
        btf.setLoading.add(container)
        appendItems(ig.getGroups().length + 1, limit)
      }, { once: true })

      container.insertAdjacentElement('afterend', button)
    }

    const appendItems = (nextGroupKey, count, isFirst) => {
      ig.append(getItems(nextGroupKey, count, isFirst), nextGroupKey)
    }

    // Event handlers
    const handleRenderComplete = e => {
      if (tabs) {
        const parentNode = container.parentNode
        if (isLayoutHidden) {
          parentNode.style.visibility = 'visible'
        }
        if (container.offsetHeight === 0) {
          parentNode.style.visibility = 'hidden'
          isLayoutHidden = true
        }
      }

      const { updated, isResize, mounted } = e
      if (!updated.length || !mounted.length || isResize) return

      btf.loadLightbox(container.querySelectorAll('img:not(.medium-zoom-image)'))

      if (ig.getGroups().length === maxGroupKey) {
        btf.setLoading.remove(container)
        !tabs && ig.off('renderComplete', handleRenderComplete)
        return
      }

      if (isButton) {
        btf.setLoading.remove(container)
        addLoadMoreButton(container)
      }
    }

    const handleRequestAppend = btf.debounce(e => {
      const nextGroupKey = (+e.groupKey || 0) + 1

      if (nextGroupKey === 1) appendItems(nextGroupKey, firstLimit, true)
      else appendItems(nextGroupKey, limit)

      if (nextGroupKey === maxGroupKey) ig.off('requestAppend', handleRequestAppend)
    }, 300)

    btf.setLoading.add(container)
    ig.on('renderComplete', handleRenderComplete)

    if (isButton) {
      appendItems(1, firstLimit, true)
    } else {
      ig.on('requestAppend', handleRequestAppend)
      ig.renderItems()
    }

    btf.addGlobalFn('pjaxSendOnce', () => ig.destroy())
  }

  const addJustifiedGallery = async (elements, tabs = false) => {
    if (!elements.length) return

    const initGallery = async () => {
      for (const element of elements) {
        if (btf.isHidden(element) || element.classList.contains('loaded')) continue

        const config = {
          isButton: element.getAttribute('data-button') === 'true',
          limit: parseInt(element.getAttribute('data-limit'), 10),
          firstLimit: parseInt(element.getAttribute('data-first'), 10),
          tabs
        }

        const container = element.firstElementChild
        const content = container.textContent
        container.textContent = ''
        element.classList.add('loaded')

        try {
          const data = element.getAttribute('data-type') === 'url' ? await fetchUrl(content) : JSON.parse(content)
          runJustifiedGallery(container, data, config)
        } catch (error) {
          console.error('Gallery data parsing failed:', error)
        }
      }
    }

    if (typeof InfiniteGrid === 'function') {
      await initGallery()
    } else {
      await btf.getScript(GLOBAL_CONFIG.infinitegrid.js)
      await initGallery()
    }
  }

  /**
   * rightside scroll percent
   */
  const rightsideScrollPercent = currentTop => {
    const scrollPercent = btf.getScrollPercent(currentTop, document.body)
    const goUpElement = document.getElementById('go-up')

    if (scrollPercent < 95) {
      goUpElement.classList.add('show-percent')
      goUpElement.querySelector('.scroll-percent').textContent = scrollPercent
    } else {
      goUpElement.classList.remove('show-percent')
    }
  }

  /**
   * 根据滚动方向同步顶栏、右下工具栏和阅读进度。
   * 高频滚动事件按绘制帧合并，避免原 300ms 节流带来的视觉迟滞。
   */
  const scrollFn = () => {
    disposeScrollHandlers?.()

    const $rightside = document.getElementById('rightside')
    const $header = document.getElementById('page-header')
    if (!($rightside && $header)) return

    let initTop = window.scrollY || document.documentElement.scrollTop
    const isChatBtn = typeof chatBtn !== 'undefined'
    const isShowPercent = GLOBAL_CONFIG.percent.rightside

    // 文档较短时工具栏应始终可用，窗口尺寸变化时会在下一帧重新判断。
    const checkDocumentHeight = () => {
      if (document.body.scrollHeight <= window.innerHeight + 56) {
        $rightside.classList.add('rightside-show')
        return true
      }
      return false
    }

    // 保持短页面的既有展示行为，无需注册滚动监听。
    if (checkDocumentHeight()) return

    const scrollDirection = currentTop => {
      const isDown = currentTop > initTop
      initTop = currentTop
      return isDown
    }

    let flag = ''
    const updateScrollState = () => {
      const currentTop = window.scrollY || document.documentElement.scrollTop
      const isDown = scrollDirection(currentTop)
      if (currentTop > 56) {
        if (flag === '') {
          $header.classList.add('nav-fixed')
          $rightside.classList.add('rightside-show')
        }

        if (isDown) {
          if (flag !== 'down') {
            $header.classList.remove('nav-visible')
            isChatBtn && window.chatBtn.hide()
            flag = 'down'
          }
        } else if (flag !== 'up') {
          $header.classList.add('nav-visible')
          isChatBtn && window.chatBtn.show()
          flag = 'up'
        }
      } else {
        flag = ''
        if (currentTop === 0) {
          $header.classList.remove('nav-fixed', 'nav-visible')
        }
        $rightside.classList.remove('rightside-show')
      }

      isShowPercent && rightsideScrollPercent(currentTop)
    }

    const scrollTask = createFrameScheduler(updateScrollState)
    const resizeTask = createFrameScheduler(checkDocumentHeight)
    const scrollOptions = { passive: true }
    const dispose = () => {
      scrollTask.cancel()
      resizeTask.cancel()
      window.removeEventListener('scroll', scrollTask, scrollOptions)
      window.removeEventListener('resize', resizeTask)
      if (disposeScrollHandlers === dispose) disposeScrollHandlers = null
    }

    btf.addEventListenerPjax(window, 'scroll', scrollTask, scrollOptions)
    btf.addEventListenerPjax(window, 'resize', resizeTask)
    btf.addGlobalFn('pjaxSendOnce', dispose, 'mainScrollFrameCleanup')
    disposeScrollHandlers = dispose
    updateScrollState()
  }

  /**
   * 同步文章目录、锚点和目录阅读进度，并在目录项变化时于同一帧完成定位。
   * 所有临时调度和监听都会在 PJAX 发送前或重新初始化前被清理。
   */
  const scrollFnToDo = () => {
    disposeTocHandlers?.()

    const isToc = GLOBAL_CONFIG_SITE.isToc
    const isAnchor = GLOBAL_CONFIG.isAnchor
    const $article = document.getElementById('article-container')
    if (!($article && (isToc || isAnchor))) return

    let $tocLink = []
    let $cardToc
    let $tocPercentage
    let isExpand = false
    let tocItemClickFn
    let scheduleAutoScroll
    let hasToc = false

    if (isToc) {
      const $cardTocLayout = document.getElementById('card-toc')
      $cardToc = $cardTocLayout?.querySelector('.toc-content')

      if ($cardToc) {
        hasToc = true
        $tocLink = $cardToc.querySelectorAll('.toc-link')
        $tocPercentage = $cardTocLayout.querySelector('.toc-percentage')
        isExpand = $cardToc.classList.contains('is-expand')

        // 目录点击保持原有平滑滚动，并在移动端自动收起目录面板。
        tocItemClickFn = e => {
          const target = e.target.closest('.toc-link')
          if (!target) return

          const targetEle = document.getElementById(decodeURI(target.getAttribute('href')).replace('#', ''))
          if (!targetEle) return

          e.preventDefault()
          btf.scrollToDest(btf.getEleTop(targetEle), 300)
          if (window.innerWidth < 900) {
            $cardTocLayout.classList.remove('open')
          }
        }

        btf.addEventListenerPjax($cardToc, 'click', tocItemClickFn)

        const autoScrollToc = item => {
          if (!item.isConnected) return

          const sidebarHeight = $cardToc.clientHeight
          const itemHeight = item.clientHeight
          const maxScrollTop = Math.max(0, $cardToc.scrollHeight - sidebarHeight)
          const targetScrollTop = Math.max(0, Math.min(maxScrollTop, item.offsetTop - (sidebarHeight - itemHeight) / 2))

          if (Math.abs($cardToc.scrollTop - targetScrollTop) > 1) {
            $cardToc.scrollTop = targetScrollTop
          }
        }

        scheduleAutoScroll = createFrameScheduler(autoScrollToc)

        // 处理 hexo-blog-encrypt 解密后重新生成的目录内容。
        $cardToc.style.display = 'block'
      }
    }

    const $articleList = Array.from($article.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    let detectItem = ''
    let headerList = []

    // 缓存标题位置，滚动时只在内存中检索，避免重复测量文档布局。
    const updateHeaderPositions = () => {
      headerList = $articleList.map(ele => ({
        ele,
        top: btf.getEleTop(ele),
        id: ele.id
      }))
    }

    const findHeadPosition = top => {
      if (top === 0) return false

      let currentId = ''
      let currentIndex = ''
      let startIndex = 0
      let endIndex = headerList.length - 1

      // 标题位置按文档顺序有序，二分查找可降低长文滚动时的计算量。
      while (startIndex <= endIndex) {
        const middleIndex = Math.floor((startIndex + endIndex) / 2)
        const item = headerList[middleIndex]

        if (top > item.top - 80) {
          currentId = item.id ? '#' + encodeURI(item.id) : ''
          currentIndex = middleIndex
          startIndex = middleIndex + 1
        } else {
          endIndex = middleIndex - 1
        }
      }

      if (detectItem === currentIndex) return

      if (isAnchor) btf.updateAnchor(currentId)
      detectItem = currentIndex

      if (hasToc) {
        $cardToc.querySelectorAll('.active').forEach(i => i.classList.remove('active'))

        if (currentId) {
          const currentActive = $tocLink[currentIndex]
          if (!currentActive) return

          currentActive.classList.add('active')
          scheduleAutoScroll(currentActive)

          if (!isExpand) {
            let parent = currentActive.parentNode
            while (parent && !parent.matches('.toc')) {
              if (parent.matches('li')) parent.classList.add('active')
              parent = parent.parentNode
            }
          }
        }
      }
    }

    const updateTocState = () => {
      const currentTop = window.scrollY || document.documentElement.scrollTop
      if (hasToc && GLOBAL_CONFIG.percent.toc && $tocPercentage) {
        $tocPercentage.textContent = btf.getScrollPercent(currentTop, $article)
      }
      findHeadPosition(currentTop)
    }

    updateHeaderPositions()

    const tocScrollTask = createFrameScheduler(updateTocState)
    const tocResizeTask = createFrameScheduler(() => {
      updateHeaderPositions()
      updateTocState()
    })
    const scrollOptions = { passive: true }
    const dispose = () => {
      tocScrollTask.cancel()
      tocResizeTask.cancel()
      scheduleAutoScroll?.cancel()
      if (hasToc) $cardToc.removeEventListener('click', tocItemClickFn)
      window.removeEventListener('scroll', tocScrollTask, scrollOptions)
      window.removeEventListener('resize', tocResizeTask)
      if (disposeTocHandlers === dispose) disposeTocHandlers = null
    }

    btf.addEventListenerPjax(window, 'scroll', tocScrollTask, scrollOptions)
    btf.addEventListenerPjax(window, 'resize', tocResizeTask)
    btf.addGlobalFn('pjaxSendOnce', dispose, 'mainTocFrameCleanup')
    disposeTocHandlers = dispose
    updateTocState()
  }

  const handleThemeChange = mode => {
    const globalFn = window.globalFn || {}
    const themeChange = globalFn.themeChange || {}
    if (!themeChange) {
      return
    }

    Object.keys(themeChange).forEach(key => {
      const themeChangeFn = themeChange[key]
      if (['disqus', 'disqusjs'].includes(key)) {
        setTimeout(() => themeChangeFn(mode), 300)
      } else {
        themeChangeFn(mode)
      }
    })
  }

  /**
   * Rightside
   */
  const rightSideFn = {
    readmode: () => { // read mode
      const $body = document.body
      const newEle = document.createElement('button')

      const exitReadMode = () => {
        $body.classList.remove('read-mode')
        newEle.remove()
        newEle.removeEventListener('click', exitReadMode)
      }

      $body.classList.add('read-mode')
      newEle.type = 'button'
      newEle.className = 'exit-readmode'
      newEle.innerHTML = '<i class="fas fa-sign-out-alt"></i>'
      newEle.addEventListener('click', exitReadMode)
      $body.appendChild(newEle)
    },
    darkmode: () => { // switch between light and dark mode
      const willChangeMode = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
      if (willChangeMode === 'dark') {
        btf.activateDarkMode()
        GLOBAL_CONFIG.Snackbar !== undefined && btf.snackbarShow(GLOBAL_CONFIG.Snackbar.day_to_night)
      } else {
        btf.activateLightMode()
        GLOBAL_CONFIG.Snackbar !== undefined && btf.snackbarShow(GLOBAL_CONFIG.Snackbar.night_to_day)
      }
      btf.saveToLocal.set('theme', willChangeMode, 2)
      handleThemeChange(willChangeMode)
    },
    'rightside-config': item => { // Show or hide rightside-hide-btn
      const hideLayout = item.firstElementChild
      if (hideLayout.classList.contains('show')) {
        hideLayout.classList.add('status')
        setTimeout(() => {
          hideLayout.classList.remove('status')
        }, 300)
      }

      hideLayout.classList.toggle('show')
    },
    'go-up': () => { // Back to top
      btf.scrollToDest(0, 500)
    },
    'hide-aside-btn': () => { // Hide aside
      const $htmlDom = document.documentElement.classList
      const saveStatus = $htmlDom.contains('hide-aside') ? 'show' : 'hide'
      btf.saveToLocal.set('aside-status', saveStatus, 2)
      $htmlDom.toggle('hide-aside')
    },
    'mobile-toc-button': (p, item) => { // Show mobile toc
      const tocEle = document.getElementById('card-toc')
      if (!tocEle) return

      const tocEleHeight = tocEle.clientHeight
      const btData = item.getBoundingClientRect()
      const tocEleBottom = window.innerHeight - btData.bottom - 30

      // 连续点击时保留正在运行的 transform，以便目录自然反向过渡。
      clearMobileTocTransition(false)
      tocEle.style.transition = 'transform 0.3s ease-in-out'
      tocEle.style.removeProperty('transform-origin')

      if (tocEleHeight > tocEleBottom) {
        tocEle.style.transformOrigin = `right ${tocEleHeight - tocEleBottom - btData.height / 2}px`
      }

      const onTransitionEnd = e => {
        if (e.target !== tocEle || e.propertyName !== 'transform') return
        clearMobileTocTransition()
      }

      mobileTocTransition = { element: tocEle, onTransitionEnd }
      tocEle.addEventListener('transitionend', onTransitionEnd)
      tocEle.addEventListener('transitioncancel', onTransitionEnd)
      btf.addGlobalFn('pjaxSendOnce', clearMobileTocTransition, 'mainMobileTocTransitionCleanup')
      tocEle.classList.toggle('open')
    },
    'chat-btn': () => { // Show chat
      window.chatBtnFn()
    },
    translateLink: () => { // switch between traditional and simplified chinese
      window.translateFn.translatePage()
    }
  }

  document.getElementById('rightside').addEventListener('click', e => {
    const $target = e.target.closest('[id]')
    if ($target && rightSideFn[$target.id]) {
      rightSideFn[$target.id](e.currentTarget, $target)
    }
  })

  /**
   * menu
   * 側邊欄sub-menu 展開/收縮
   */
  const clickFnOfSubMenu = () => {
    const handleClickOfSubMenu = e => {
      const target = e.target.closest('.site-page.group')
      if (!target) return
      target.classList.toggle('hide')
    }

    const menusItems = document.querySelector('#sidebar-menus .menus_items')
    menusItems && menusItems.addEventListener('click', handleClickOfSubMenu)
  }

  /**
   * 手机端目录点击
   */
  const openMobileMenu = () => {
    const toggleMenu = document.getElementById('toggle-menu')
    if (!toggleMenu) return
    btf.addEventListenerPjax(toggleMenu, 'click', () => { sidebarFn.open() })
  }

  /**
 * 複製時加上版權信息
 */
  const addCopyright = () => {
    const { limitCount, languages } = GLOBAL_CONFIG.copyright

    const handleCopy = e => {
      e.preventDefault()
      const copyFont = window.getSelection(0).toString()
      let textFont = copyFont
      if (copyFont.length > limitCount) {
        textFont = `${copyFont}\n\n\n${languages.author}\n${languages.link}${window.location.href}\n${languages.source}\n${languages.info}`
      }
      if (e.clipboardData) {
        return e.clipboardData.setData('text', textFont)
      } else {
        return window.clipboardData.setData('text', textFont)
      }
    }

    document.body.addEventListener('copy', handleCopy)
  }

  /**
   * 網頁運行時間
   */
  const addRuntime = () => {
    const $runtimeCount = document.getElementById('runtimeshow')
    if ($runtimeCount) {
      const publishDate = $runtimeCount.getAttribute('data-publishDate')
      $runtimeCount.textContent = `${btf.diffDate(publishDate)} ${GLOBAL_CONFIG.runtime}`
    }
  }

  /**
   * 最後一次更新時間
   */
  const addLastPushDate = () => {
    const $lastPushDateItem = document.getElementById('last-push-date')
    if ($lastPushDateItem) {
      const lastPushDate = $lastPushDateItem.getAttribute('data-lastPushDate')
      $lastPushDateItem.textContent = btf.diffDate(lastPushDate, true)
    }
  }

  /**
   * table overflow
   */
  const addTableWrap = () => {
    const $table = document.querySelectorAll('#article-container table')
    if (!$table.length) return

    $table.forEach(item => {
      if (!item.closest('.highlight')) {
        btf.wrap(item, 'div', { class: 'table-wrap' })
      }
    })
  }

  /**
   * tag-hide
   */
  const clickFnOfTagHide = () => {
    const hideButtons = document.querySelectorAll('#article-container .hide-button')
    if (!hideButtons.length) return
    hideButtons.forEach(item => item.addEventListener('click', e => {
      const currentTarget = e.currentTarget
      currentTarget.classList.add('open')
      addJustifiedGallery(currentTarget.nextElementSibling.querySelectorAll('.gallery-container'))
    }, { once: true }))
  }

  const tabsFn = () => {
    const navTabsElements = document.querySelectorAll('#article-container .tabs')
    if (!navTabsElements.length) return

    const setActiveClass = (elements, activeIndex) => {
      elements.forEach((el, index) => {
        el.classList.toggle('active', index === activeIndex)
      })
    }

    const handleNavClick = e => {
      const target = e.target.closest('button')
      if (!target || target.classList.contains('active')) return

      const navItems = [...e.currentTarget.children]
      const tabContents = [...e.currentTarget.nextElementSibling.children]
      const indexOfButton = navItems.indexOf(target)
      setActiveClass(navItems, indexOfButton)
      e.currentTarget.classList.remove('no-default')
      setActiveClass(tabContents, indexOfButton)
      addJustifiedGallery(tabContents[indexOfButton].querySelectorAll('.gallery-container'), true)
    }

    const handleToTopClick = tabElement => e => {
      if (e.target.closest('button')) {
        btf.scrollToDest(btf.getEleTop(tabElement), 300)
      }
    }

    navTabsElements.forEach(tabElement => {
      btf.addEventListenerPjax(tabElement.firstElementChild, 'click', handleNavClick)
      btf.addEventListenerPjax(tabElement.lastElementChild, 'click', handleToTopClick(tabElement))
    })
  }

  const toggleCardCategory = () => {
    const cardCategory = document.querySelector('#aside-cat-list.expandBtn')
    if (!cardCategory) return

    const handleToggleBtn = e => {
      const target = e.target
      if (target.nodeName === 'I') {
        e.preventDefault()
        target.parentNode.classList.toggle('expand')
      }
    }
    btf.addEventListenerPjax(cardCategory, 'click', handleToggleBtn, true)
  }

  const addPostOutdateNotice = () => {
    const ele = document.getElementById('post-outdate-notice')
    if (!ele) return

    const { limitDay, messagePrev, messageNext, postUpdate } = JSON.parse(ele.getAttribute('data'))
    const diffDay = btf.diffDate(postUpdate)
    if (diffDay >= limitDay) {
      ele.textContent = `${messagePrev} ${diffDay} ${messageNext}`
      ele.hidden = false
    }
  }

  const lazyloadImg = () => {
    window.lazyLoadInstance = new LazyLoad({
      elements_selector: 'img',
      threshold: 0,
      data_src: 'lazy-src'
    })

    btf.addGlobalFn('pjaxComplete', () => {
      window.lazyLoadInstance.update()
    }, 'lazyload')
  }

  const relativeDate = selector => {
    selector.forEach(item => {
      item.textContent = btf.diffDate(item.getAttribute('datetime'), true)
      item.style.display = 'inline'
    })
  }

  const justifiedIndexPostUI = () => {
    const recentPostsElement = document.getElementById('recent-posts')
    if (!(recentPostsElement && recentPostsElement.classList.contains('masonry'))) return

    const init = () => {
      const masonryItem = new InfiniteGrid.MasonryInfiniteGrid('.recent-post-items', {
        gap: { horizontal: 10, vertical: 20 },
        useTransform: true,
        useResizeObserver: true
      })
      masonryItem.renderItems()
      btf.addGlobalFn('pjaxCompleteOnce', () => { masonryItem.destroy() }, 'removeJustifiedIndexPostUI')
    }

    typeof InfiniteGrid === 'function' ? init() : btf.getScript(`${GLOBAL_CONFIG.infinitegrid.js}`).then(init)
  }

  const unRefreshFn = () => {
    window.addEventListener('resize', () => {
      adjustMenu(false)
      mobileSidebarOpen && btf.isHidden(document.getElementById('toggle-menu')) && sidebarFn.close()
    })

    const menuMask = document.getElementById('menu-mask')
    menuMask && menuMask.addEventListener('click', () => { sidebarFn.close() })

    clickFnOfSubMenu()
    GLOBAL_CONFIG.islazyloadPlugin && lazyloadImg()
    GLOBAL_CONFIG.copyright !== undefined && addCopyright()

    if (GLOBAL_CONFIG.autoDarkmode) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        if (btf.saveToLocal.get('theme') !== undefined) return
        e.matches ? handleThemeChange('dark') : handleThemeChange('light')
      })
    }
  }

  const forPostFn = () => {
    addHighlightTool()
    addPhotoFigcaption()
    addJustifiedGallery(document.querySelectorAll('#article-container .gallery-container'))
    runLightbox()
    scrollFnToDo()
    addTableWrap()
    clickFnOfTagHide()
    tabsFn()
  }

  const refreshFn = () => {
    initAdjust()
    justifiedIndexPostUI()

    if (GLOBAL_CONFIG_SITE.pageType === 'post') {
      addPostOutdateNotice()
      GLOBAL_CONFIG.relativeDate.post && relativeDate(document.querySelectorAll('#post-meta time'))
    } else {
      GLOBAL_CONFIG.relativeDate.homepage && relativeDate(document.querySelectorAll('#recent-posts time'))
      GLOBAL_CONFIG.runtime && addRuntime()
      addLastPushDate()
      toggleCardCategory()
    }

    GLOBAL_CONFIG_SITE.pageType === 'home' && scrollDownInIndex()
    scrollFn()

    forPostFn()
    GLOBAL_CONFIG_SITE.pageType !== 'shuoshuo' && btf.switchComments(document)
    openMobileMenu()
  }

  btf.addGlobalFn('pjaxComplete', refreshFn, 'refreshFn')
  refreshFn()
  unRefreshFn()

  // 處理 hexo-blog-encrypt 事件
  window.addEventListener('hexo-blog-decrypt', e => {
    forPostFn()
    window.translateFn.translateInitialization()
    Object.values(window.globalFn.encrypt).forEach(fn => {
      fn()
    })
  })
})
