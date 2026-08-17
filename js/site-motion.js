/**
 * Persistent disclosure motion for homepage topics and article hideToggle blocks.
 *
 * Native <details> remains responsible for disclosure semantics. This module
 * intercepts supported summary clicks to animate measured panel dimensions
 * with the Web Animations API. Delegated listeners keep the behaviour working
 * after Butterfly PJAX replaces the route content.
 */
(() => {
  'use strict';

  const INITIALIZED_KEY = '__blogSiteMotionInitialized__';
  const TOPIC_SELECTOR = 'details.topic-collection';
  const PANEL_SELECTOR = '.topic-collection__posts';
  const ARTICLE_TOGGLE_SELECTOR = '#article-container details.toggle';
  const ARTICLE_TOGGLE_PANEL_SELECTOR = '.toggle-content';
  const EXPANDED_ATTRIBUTE = 'data-topic-expanded';
  const ARTICLE_TOGGLE_EXPANDED_ATTRIBUTE = 'data-toggle-expanded';
  const STORAGE_KEY = 'blog.topic-collection.open.v1';
  const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const FULL_DURATION = 360;
  const MIN_DURATION = 120;
  const MAX_DURATION = 420;

  // A repeated script execution can happen when a PJAX integration reloads
  // injected scripts. Keep exactly one delegated listener for the document.
  if (window[INITIALIZED_KEY]) {
    return;
  }

  window[INITIALIZED_KEY] = true;

  const motionStates = new WeakMap();
  const activeDetails = new Set();
  const articleToggleStates = new WeakMap();
  const activeArticleToggles = new Set();
  let storedTopicStates = null;
  let storageChecked = false;
  let storage = null;
  const reducedMotionQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  document.documentElement.classList.add('site-motion-ready');

  /**
   * Store transient animation state without placing implementation details in
   * the document markup. The target state, rather than details.open alone,
   * allows a second click to reverse an in-flight closing transition.
   */
  function getMotionState(details) {
    let state = motionStates.get(details);

    if (!state) {
      state = {
        indicatorAnimation: null,
        motionId: 0,
        panelAnimation: null,
        panelInlineStyles: null,
        targetOpen: details.open,
      };
      motionStates.set(details, state);
    }

    return state;
  }

  /**
   * Read direct children rather than querying the full subtree, so nested
   * details components cannot accidentally be treated as this collection.
   */
  function getDirectChild(details, selector) {
    for (const child of details.children) {
      if (child.matches(selector)) {
        return child;
      }
    }

    return null;
  }

  function getSummary(details) {
    return getDirectChild(details, 'summary');
  }

  function getPanel(details) {
    return getDirectChild(details, PANEL_SELECTOR);
  }

  function getIndicator(details) {
    const summary = getSummary(details);
    return summary ? summary.querySelector('.topic-collection__indicator') : null;
  }

  function isTopicCollection(details) {
    return details instanceof HTMLElement && details.matches(TOPIC_SELECTOR);
  }

  function prefersReducedMotion() {
    return Boolean(reducedMotionQuery && reducedMotionQuery.matches);
  }

  /**
   * Reflect the real open property to assistive technology. The native details
   * element still supplies its built-in keyboard and disclosure behaviour.
   */
  function syncSummaryAria(details) {
    const summary = getSummary(details);

    if (summary) {
      summary.setAttribute('aria-expanded', String(details.open));
    }
  }

  function setTargetState(details, expanded) {
    details.setAttribute(EXPANDED_ATTRIBUTE, String(expanded));
  }

  /**
   * Return sessionStorage only after a small guarded probe. Privacy settings
   * and embedded browsers can expose the API while rejecting every access.
   */
  function getSessionStorage() {
    if (storageChecked) {
      return storage;
    }

    storageChecked = true;

    try {
      const probeKey = `${STORAGE_KEY}.probe`;
      storage = window.sessionStorage;
      storage.setItem(probeKey, '1');
      storage.removeItem(probeKey);
    } catch (error) {
      storage = null;
    }

    return storage;
  }

  /**
   * A custom data-topic-key can be added later, while the rendered title is a
   * stable fallback for the current Hexo topic cards.
   */
  function getTopicStorageId(details) {
    const explicitKey = details.getAttribute('data-topic-key');
    if (explicitKey && explicitKey.trim()) {
      return `key:${explicitKey.trim()}`;
    }

    const summary = getSummary(details);
    const title = summary ? summary.querySelector('.article-title') : null;
    const rawTitle = title ? title.getAttribute('title') || title.textContent || '' : '';
    const normalizedTitle = rawTitle.replace(/\s+/g, ' ').trim();

    return normalizedTitle ? `title:${normalizedTitle}` : null;
  }

  function readStoredTopicStates() {
    if (storedTopicStates) {
      return storedTopicStates;
    }

    const sessionStorage = getSessionStorage();
    if (!sessionStorage) {
      storedTopicStates = {};
      return storedTopicStates;
    }

    try {
      const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}');
      storedTopicStates = parsed && !Array.isArray(parsed) && typeof parsed === 'object'
        ? parsed
        : {};
    } catch (error) {
      storedTopicStates = {};
    }

    return storedTopicStates;
  }

  /**
   * Persist only expanded cards. Closed cards are removed from the record,
   * keeping the session payload small and making stale topics harmless.
   */
  function persistTopicState(details, expanded) {
    const storageId = getTopicStorageId(details);
    const sessionStorage = getSessionStorage();

    if (!storageId || !sessionStorage) {
      return;
    }

    const savedStates = readStoredTopicStates();
    if (expanded) {
      savedStates[storageId] = true;
    } else {
      delete savedStates[storageId];
    }

    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(savedStates));
    } catch (error) {
      // Storage can become unavailable after the page has already loaded.
    }
  }

  /**
   * Preserve pre-existing inline values so this enhancement does not erase a
   * future per-page style override once the transition is complete.
   */
  function rememberPanelInlineStyles(panel, state) {
    if (state.panelInlineStyles) {
      return;
    }

    state.panelInlineStyles = {
      borderTopColor: panel.style.borderTopColor,
      height: panel.style.height,
      marginBottom: panel.style.marginBottom,
      opacity: panel.style.opacity,
    };
  }

  function restorePanelInlineStyles(panel, state) {
    if (!state.panelInlineStyles) {
      return;
    }

    const original = state.panelInlineStyles;
    panel.style.borderTopColor = original.borderTopColor;
    panel.style.height = original.height;
    panel.style.marginBottom = original.marginBottom;
    panel.style.opacity = original.opacity;
    state.panelInlineStyles = null;
  }

  function parseLength(value, fallback = 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  /**
   * Capture the visual state before cancelling a running animation. Computed
   * values make an interrupted transition continue from its current frame.
   */
  function readPanelState(panel) {
    const computed = window.getComputedStyle(panel);
    const computedHeight = parseLength(computed.height, panel.scrollHeight);
    const opacity = parseLength(computed.opacity, 1);

    return {
      borderTopColor: computed.borderTopColor,
      height: Math.max(0, computedHeight),
      marginBottom: computed.marginBottom,
      opacity: Math.min(1, Math.max(0, opacity)),
    };
  }

  function getCollapsedPanelState() {
    return {
      borderTopColor: 'rgba(0, 0, 0, 0)',
      height: 0,
      marginBottom: '0px',
      opacity: 0,
    };
  }

  /**
   * details.open has already been set before this function is called, so the
   * browser lays out the panel and scrollHeight represents its real content.
   */
  function readExpandedPanelState(panel, originalInlineStyles) {
    const temporaryInlineStyles = {
      borderTopColor: panel.style.borderTopColor,
      height: panel.style.height,
      marginBottom: panel.style.marginBottom,
      opacity: panel.style.opacity,
    };
    const baselineStyles = originalInlineStyles || {
      borderTopColor: '',
      height: '',
      marginBottom: '',
      opacity: '',
    };

    // A reversed transition leaves its previous start values inline. Temporarily
    // expose the authored/CSS end state so opacity, divider and spacing do not
    // inherit an intermediate frame as the next animation's destination.
    panel.style.borderTopColor = baselineStyles.borderTopColor;
    panel.style.height = baselineStyles.height;
    panel.style.marginBottom = baselineStyles.marginBottom;
    panel.style.opacity = baselineStyles.opacity;

    const expandedState = readPanelState(panel);
    expandedState.height = Math.max(0, panel.scrollHeight);

    panel.style.borderTopColor = temporaryInlineStyles.borderTopColor;
    panel.style.height = temporaryInlineStyles.height;
    panel.style.marginBottom = temporaryInlineStyles.marginBottom;
    panel.style.opacity = temporaryInlineStyles.opacity;

    return expandedState;
  }

  function applyPanelState(panel, visualState) {
    panel.style.borderTopColor = visualState.borderTopColor;
    panel.style.height = `${visualState.height}px`;
    panel.style.marginBottom = visualState.marginBottom;
    panel.style.opacity = String(visualState.opacity);
  }

  function createPanelKeyframe(visualState) {
    return {
      borderTopColor: visualState.borderTopColor,
      height: `${visualState.height}px`,
      marginBottom: visualState.marginBottom,
      opacity: visualState.opacity,
    };
  }

  /**
   * Scale the duration by travelled height. Reversing a nearly-complete motion
   * therefore feels immediate without making a full-size collection abrupt.
   */
  function getDuration(from, to, fullHeight) {
    const distance = Math.abs(to.height - from.height);
    const referenceHeight = Math.max(fullHeight, 1);
    const scaledDuration = FULL_DURATION * (distance / referenceHeight);

    return Math.round(Math.min(MAX_DURATION, Math.max(MIN_DURATION, scaledDuration)));
  }

  function cancelAnimation(animation) {
    if (animation) {
      animation.cancel();
    }
  }

  function cancelActiveAnimations(state) {
    cancelAnimation(state.panelAnimation);
    cancelAnimation(state.indicatorAnimation);
    state.panelAnimation = null;
    state.indicatorAnimation = null;
  }

  function readIndicatorTransform(indicator) {
    const transform = window.getComputedStyle(indicator).transform;
    return transform === 'none' ? 'rotate(0deg)' : transform;
  }

  function animateIndicator(details, state, startTransform, expanded, duration, motionId) {
    const indicator = getIndicator(details);

    if (!indicator || typeof indicator.animate !== 'function') {
      return;
    }

    const animation = indicator.animate(
      [
        { transform: startTransform },
        { transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' },
      ],
      {
        duration,
        easing: EASING,
        fill: 'both',
      },
    );

    state.indicatorAnimation = animation;
    animation.finished
      .then(() => {
        if (state.motionId !== motionId || state.indicatorAnimation !== animation) {
          return;
        }

        state.indicatorAnimation = null;
        animation.cancel();
      })
      .catch(() => {});
  }

  /**
   * Complete an active transition without animation when the user enables
   * reduced motion while it is playing.
   */
  function settleImmediately(details, state) {
    state.motionId += 1;
    cancelActiveAnimations(state);

    details.open = state.targetOpen;
    setTargetState(details, state.targetOpen);
    syncSummaryAria(details);

    const panel = getPanel(details);
    if (panel) {
      restorePanelInlineStyles(panel, state);
    }

    activeDetails.delete(details);
  }

  /**
   * Animate an individual topic collection to its requested disclosure state.
   * It intentionally leaves details open until a closing animation ends; this
   * keeps native semantics and content measurement valid throughout motion.
   */
  function setTopicExpanded(details, expanded) {
    const panel = getPanel(details);
    const state = getMotionState(details);

    if (!panel) {
      state.targetOpen = expanded;
      details.open = expanded;
      setTargetState(details, expanded);
      syncSummaryAria(details);
      persistTopicState(details, expanded);
      return;
    }

    if (state.targetOpen === expanded && !state.panelAnimation) {
      setTargetState(details, expanded);
      syncSummaryAria(details);
      return;
    }

    const wasOpen = details.open;
    const currentPanelState = wasOpen ? readPanelState(panel) : getCollapsedPanelState();
    const indicator = getIndicator(details);
    const currentIndicatorTransform = indicator ? readIndicatorTransform(indicator) : 'rotate(0deg)';

    state.motionId += 1;
    const motionId = state.motionId;
    state.targetOpen = expanded;
    cancelActiveAnimations(state);
    setTargetState(details, expanded);
    persistTopicState(details, expanded);

    if (prefersReducedMotion() || typeof panel.animate !== 'function') {
      details.open = expanded;
      syncSummaryAria(details);
      restorePanelInlineStyles(panel, state);
      activeDetails.delete(details);
      return;
    }

    if (expanded && !details.open) {
      details.open = true;
      syncSummaryAria(details);
    }

    const from = expanded && !wasOpen ? getCollapsedPanelState() : currentPanelState;
    const to = expanded
      ? readExpandedPanelState(panel, state.panelInlineStyles)
      : getCollapsedPanelState();
    const duration = getDuration(from, to, Math.max(panel.scrollHeight, from.height, to.height));

    rememberPanelInlineStyles(panel, state);
    applyPanelState(panel, from);
    activeDetails.add(details);

    animateIndicator(details, state, currentIndicatorTransform, expanded, duration, motionId);

    const animation = panel.animate(
      [createPanelKeyframe(from), createPanelKeyframe(to)],
      {
        duration,
        easing: EASING,
        fill: 'both',
      },
    );

    state.panelAnimation = animation;
    animation.finished
      .then(() => {
        if (state.motionId !== motionId || state.panelAnimation !== animation) {
          return;
        }

        state.panelAnimation = null;

        if (!expanded) {
          details.open = false;
        }

        syncSummaryAria(details);
        restorePanelInlineStyles(panel, state);
        activeDetails.delete(details);
        animation.cancel();
      })
      .catch(() => {});
  }

  /** Return the independent motion state for an article hideToggle block. */
  function getArticleToggleState(details) {
    let state = articleToggleStates.get(details);

    if (!state) {
      state = {
        animation: null,
        motionId: 0,
        panelInlineStyles: null,
        targetOpen: details.open,
      };
      articleToggleStates.set(details, state);
    }

    return state;
  }

  function isArticleToggle(details) {
    return details instanceof HTMLElement && details.matches(ARTICLE_TOGGLE_SELECTOR);
  }

  function getArticleTogglePanel(details) {
    return getDirectChild(details, ARTICLE_TOGGLE_PANEL_SELECTOR);
  }

  /** Keep the arrow and accessibility state aligned with the visual target. */
  function syncArticleToggleState(details, expanded) {
    details.setAttribute(ARTICLE_TOGGLE_EXPANDED_ATTRIBUTE, String(expanded));
    getSummary(details)?.setAttribute('aria-expanded', String(expanded));
  }

  /** Preserve authored inline values while the panel owns its transition. */
  function rememberArticleToggleStyles(panel, state) {
    if (state.panelInlineStyles) {
      return;
    }

    state.panelInlineStyles = {
      height: panel.style.height,
      marginBottom: panel.style.marginBottom,
      marginTop: panel.style.marginTop,
      opacity: panel.style.opacity,
      overflow: panel.style.overflow,
      willChange: panel.style.willChange,
    };
  }

  function restoreArticleToggleStyles(panel, state) {
    if (!state.panelInlineStyles) {
      return;
    }

    const original = state.panelInlineStyles;
    panel.style.height = original.height;
    panel.style.marginBottom = original.marginBottom;
    panel.style.marginTop = original.marginTop;
    panel.style.opacity = original.opacity;
    panel.style.overflow = original.overflow;
    panel.style.willChange = original.willChange;
    state.panelInlineStyles = null;
  }

  function getCollapsedArticleToggleState() {
    return {
      height: 0,
      marginBottom: '0px',
      marginTop: '0px',
      opacity: 0,
    };
  }

  /** Read the currently painted frame so a second click can reverse smoothly. */
  function readArticleTogglePanelState(panel) {
    const computed = window.getComputedStyle(panel);

    return {
      height: Math.max(0, parseLength(computed.height, panel.scrollHeight)),
      marginBottom: computed.marginBottom,
      marginTop: computed.marginTop,
      opacity: Math.min(1, Math.max(0, parseLength(computed.opacity, 1))),
    };
  }

  /** Measure the authored expanded state without inheriting an interrupted frame. */
  function readExpandedArticleToggleState(panel, state) {
    const temporary = {
      height: panel.style.height,
      marginBottom: panel.style.marginBottom,
      marginTop: panel.style.marginTop,
      opacity: panel.style.opacity,
      overflow: panel.style.overflow,
      willChange: panel.style.willChange,
    };
    const baseline = state.panelInlineStyles || {
      height: '',
      marginBottom: '',
      marginTop: '',
      opacity: '',
      overflow: '',
      willChange: '',
    };

    panel.style.height = baseline.height;
    panel.style.marginBottom = baseline.marginBottom;
    panel.style.marginTop = baseline.marginTop;
    panel.style.opacity = baseline.opacity;
    panel.style.overflow = baseline.overflow;
    panel.style.willChange = baseline.willChange;

    const expandedState = readArticleTogglePanelState(panel);
    expandedState.height = Math.max(0, panel.scrollHeight);

    panel.style.height = temporary.height;
    panel.style.marginBottom = temporary.marginBottom;
    panel.style.marginTop = temporary.marginTop;
    panel.style.opacity = temporary.opacity;
    panel.style.overflow = temporary.overflow;
    panel.style.willChange = temporary.willChange;

    return expandedState;
  }

  function applyArticleTogglePanelState(panel, visualState) {
    panel.style.height = `${visualState.height}px`;
    panel.style.marginBottom = visualState.marginBottom;
    panel.style.marginTop = visualState.marginTop;
    panel.style.opacity = String(visualState.opacity);
    panel.style.overflow = 'hidden';
    panel.style.willChange = 'height, opacity';
  }

  function createArticleToggleKeyframe(visualState) {
    return {
      height: `${visualState.height}px`,
      marginBottom: visualState.marginBottom,
      marginTop: visualState.marginTop,
      opacity: visualState.opacity,
    };
  }

  /** Finish an article disclosure immediately during PJAX or reduced motion. */
  function settleArticleToggle(details, state = articleToggleStates.get(details)) {
    if (!state) {
      return;
    }

    state.motionId += 1;
    const animation = state.animation;
    state.animation = null;
    animation?.cancel();
    details.open = state.targetOpen;
    syncArticleToggleState(details, state.targetOpen);

    const panel = getArticleTogglePanel(details);
    if (panel) {
      restoreArticleToggleStyles(panel, state);
    }

    activeArticleToggles.delete(details);
  }

  /**
   * Animate article hideToggle content with measured height, spacing and
   * opacity. The details element remains open until a closing frame finishes.
   */
  function setArticleToggleExpanded(details, expanded) {
    const panel = getArticleTogglePanel(details);
    const state = getArticleToggleState(details);

    if (!panel) {
      state.targetOpen = expanded;
      details.open = expanded;
      syncArticleToggleState(details, expanded);
      return;
    }

    if (state.targetOpen === expanded && !state.animation) {
      syncArticleToggleState(details, expanded);
      return;
    }

    const wasOpen = details.open;
    const from = wasOpen
      ? readArticleTogglePanelState(panel)
      : getCollapsedArticleToggleState();

    state.motionId += 1;
    const motionId = state.motionId;
    const previousAnimation = state.animation;
    state.animation = null;
    previousAnimation?.cancel();
    state.targetOpen = expanded;
    rememberArticleToggleStyles(panel, state);
    syncArticleToggleState(details, expanded);

    if (prefersReducedMotion() || typeof panel.animate !== 'function') {
      details.open = expanded;
      restoreArticleToggleStyles(panel, state);
      activeArticleToggles.delete(details);
      return;
    }

    if (!details.open) {
      details.open = true;
    }

    const to = expanded
      ? readExpandedArticleToggleState(panel, state)
      : getCollapsedArticleToggleState();
    const duration = getDuration(from, to, Math.max(panel.scrollHeight, from.height, to.height));

    applyArticleTogglePanelState(panel, from);
    activeArticleToggles.add(details);

    const animation = panel.animate(
      [createArticleToggleKeyframe(from), createArticleToggleKeyframe(to)],
      {
        duration,
        easing: EASING,
        fill: 'both',
      },
    );

    state.animation = animation;
    animation.finished
      .then(() => {
        if (state.motionId !== motionId || state.animation !== animation) {
          return;
        }

        state.animation = null;
        if (!expanded) {
          details.open = false;
        }

        syncArticleToggleState(details, expanded);
        restoreArticleToggleStyles(panel, state);
        activeArticleToggles.delete(details);
        animation.cancel();
      })
      .catch(() => {});
  }

  /**
   * Capture clicks at the document level. PJAX may replace the homepage nodes,
   * but this single listener continues to handle their new summaries.
   */
  function handleSummaryClick(event) {
    if (event.defaultPrevented || !(event.target instanceof Element)) {
      return;
    }

    const summary = event.target.closest('summary');
    const details = summary ? summary.parentElement : null;

    if (!summary || !isTopicCollection(details) || getSummary(details) !== summary) {
      return;
    }

    event.preventDefault();

    const state = getMotionState(details);
    setTopicExpanded(details, !state.targetOpen);
  }

  /** Intercept article hideToggle summaries through the same PJAX-safe delegate. */
  function handleArticleToggleSummaryClick(event) {
    if (event.defaultPrevented || !(event.target instanceof Element)) {
      return;
    }

    const summary = event.target.closest('summary');
    const details = summary ? summary.parentElement : null;

    if (!summary || !isArticleToggle(details) || getSummary(details) !== summary) {
      return;
    }

    event.preventDefault();

    const state = getArticleToggleState(details);
    setArticleToggleExpanded(details, !state.targetOpen);
  }

  /**
   * Keep explicitly changed or script-free details elements in sync with their
   * native state. A closing animation retains its target attribute until the
   * actual open property is changed after the final frame.
   */
  function handleDetailsToggle(event) {
    const details = event.target;

    if (!isTopicCollection(details)) {
      return;
    }

    const state = motionStates.get(details);
    if (!state || !state.panelAnimation) {
      getMotionState(details).targetOpen = details.open;
      setTargetState(details, details.open);
      persistTopicState(details, details.open);
    }

    syncSummaryAria(details);
  }

  /** Accept changes made by other scripts when this module is not animating. */
  function handleArticleToggleNativeToggle(event) {
    const details = event.target;

    if (!isArticleToggle(details)) {
      return;
    }

    const state = getArticleToggleState(details);
    if (!state.animation) {
      state.targetOpen = details.open;
      syncArticleToggleState(details, details.open);
    }
  }

  /**
   * Restore only the saved, expanded topic cards. This runs after the initial
   * document is ready and after PJAX swaps the homepage markup, without
   * attaching listeners to individual cards.
   */
  function restoreStoredTopicStates(root = document) {
    const savedStates = readStoredTopicStates();
    const collections = root.querySelectorAll(
      '#recent-posts.two-level-root details.topic-collection',
    );

    collections.forEach((details) => {
      const storageId = getTopicStorageId(details);
      const shouldExpand = storageId && savedStates[storageId] === true;
      const state = getMotionState(details);

      if (shouldExpand) {
        details.open = true;
      }

      state.targetOpen = details.open;
      setTargetState(details, details.open);
      syncSummaryAria(details);
    });
  }

  /** Synchronize article disclosure state after initial load and every PJAX swap. */
  function initializeArticleToggles(root = document) {
    root.querySelectorAll(ARTICLE_TOGGLE_SELECTOR).forEach((details) => {
      const state = getArticleToggleState(details);
      if (state.animation) {
        return;
      }

      state.targetOpen = details.open;
      syncArticleToggleState(details, details.open);
    });
  }

  function initializeMotionTargets() {
    restoreStoredTopicStates();
    initializeArticleToggles();
  }

  /**
   * Apply route-local disclosure state before PJAX inserts the incoming view.
   * This prevents a restored homepage from painting once in its default
   * collapsed state and only opening after pjax:complete.
   */
  function prepareRouteContent(root) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      return;
    }

    restoreStoredTopicStates(root);
    initializeArticleToggles(root);
  }

  /** Settle transient article panels before their route nodes are detached. */
  function settleArticleTogglesBeforeNavigation() {
    Array.from(activeArticleToggles).forEach((details) => {
      settleArticleToggle(details);
    });
  }

  document.addEventListener('click', handleSummaryClick);
  document.addEventListener('click', handleArticleToggleSummaryClick);
  document.addEventListener('toggle', handleDetailsToggle, true);
  document.addEventListener('toggle', handleArticleToggleNativeToggle, true);
  document.addEventListener('pjax:send', settleArticleTogglesBeforeNavigation);
  document.addEventListener('pjax:complete', initializeMotionTargets);

  window.SiteMotion = Object.freeze({
    prepareRouteContent,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeMotionTargets, { once: true });
  } else {
    initializeMotionTargets();
  }

  window.addEventListener('pageshow', initializeMotionTargets);

  if (reducedMotionQuery) {
    const handleReducedMotionChange = () => {
      if (!prefersReducedMotion()) {
        return;
      }

      activeDetails.forEach((details) => {
        const state = motionStates.get(details);

        if (state) {
          settleImmediately(details, state);
        }
      });

      Array.from(activeArticleToggles).forEach((details) => {
        settleArticleToggle(details);
      });
    };

    if (typeof reducedMotionQuery.addEventListener === 'function') {
      reducedMotionQuery.addEventListener('change', handleReducedMotionChange);
    } else if (typeof reducedMotionQuery.addListener === 'function') {
      reducedMotionQuery.addListener(handleReducedMotionChange);
    }
  }
})();
