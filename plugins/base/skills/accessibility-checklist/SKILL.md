---
name: Accessibility Checklist
description: Comprehensive WCAG 2.2 Level AA compliance checklist with WAI-ARIA patterns, testing procedures, and practical implementation guidance
---

# Accessibility Checklist

A comprehensive guide to ensuring your web applications meet WCAG 2.2 Level AA accessibility standards, with practical checklists, ARIA patterns, and testing procedures.

## Table of Contents

- [WCAG 2.2 Principles](#wcag-22-principles)
- [Perceivable](#perceivable)
- [Operable](#operable)
- [Understandable](#understandable)
- [Robust](#robust)
- [WAI-ARIA Patterns](#wai-aria-patterns)
- [Testing Checklist](#testing-checklist)
- [Tools and Resources](#tools-and-resources)

---

## WCAG 2.2 Principles

Web Content Accessibility Guidelines (WCAG) 2.2 are organized around four principles (POUR):

1. **Perceivable**: Information must be presentable to users in ways they can perceive
2. **Operable**: Interface components must be operable by all users
3. **Understandable**: Information and operation must be understandable
4. **Robust**: Content must be robust enough to work with current and future technologies

---

## Perceivable

Information and user interface components must be presentable to users in ways they can perceive.

### 1.1 Text Alternatives

Provide text alternatives for non-text content.

#### Checklist

- [ ] All images have appropriate `alt` text
- [ ] Decorative images use `alt=""` or `role="presentation"`
- [ ] Complex images (charts, diagrams) have detailed descriptions
- [ ] Icons used for actions have accessible labels
- [ ] Form inputs have associated labels
- [ ] CAPTCHAs have alternative forms available

#### Examples

**Good Image Alt Text:**
```html
<!-- Informative image -->
<img src="chart.png" alt="Bar chart showing 40% increase in sales from Q1 to Q2 2025">

<!-- Decorative image -->
<img src="decorative-line.png" alt="" role="presentation">

<!-- Functional image (button) -->
<button>
  <img src="search-icon.svg" alt="Search">
</button>

<!-- Complex image with long description -->
<img
  src="architecture-diagram.png"
  alt="System architecture diagram"
  aria-describedby="arch-description"
>
<div id="arch-description">
  The diagram shows three layers: presentation tier with React frontend,
  application tier with Node.js API, and data tier with PostgreSQL database.
  Arrows indicate data flow between layers.
</div>
```

### 1.2 Time-Based Media

Provide alternatives for time-based media (audio, video).

#### Checklist

- [ ] Pre-recorded audio has text transcript
- [ ] Pre-recorded video has captions and audio description
- [ ] Live audio has captions
- [ ] Media player controls are keyboard accessible
- [ ] Auto-playing media can be paused
- [ ] Transcripts are linked near media

#### Examples

```html
<video controls aria-label="Product demo video">
  <source src="demo.mp4" type="video/mp4">
  <track kind="captions" src="captions.vtt" srclang="en" label="English">
  <track kind="descriptions" src="descriptions.vtt" srclang="en">
</video>

<a href="transcript.html">View video transcript</a>
```

### 1.3 Adaptable

Create content that can be presented in different ways without losing information.

#### Checklist

- [ ] Semantic HTML is used (headings, lists, nav, main, etc.)
- [ ] Heading hierarchy is logical (h1 → h2 → h3, no skipping)
- [ ] Lists use proper markup (`<ul>`, `<ol>`, `<dl>`)
- [ ] Tables use `<th>` for headers and appropriate scope
- [ ] Form fields are grouped with `<fieldset>` and `<legend>`
- [ ] Reading order matches visual order
- [ ] Content adapts to different screen sizes
- [ ] Information is not conveyed by shape, size, or location alone

#### Examples

**Good Semantic Structure:**
```html
<main>
  <h1>Page Title</h1>

  <nav aria-label="Main navigation">
    <ul>
      <li><a href="#section1">Section 1</a></li>
      <li><a href="#section2">Section 2</a></li>
    </ul>
  </nav>

  <section>
    <h2>Section Title</h2>
    <p>Content...</p>

    <h3>Subsection</h3>
    <p>More content...</p>
  </section>

  <aside aria-label="Related links">
    <h2>Related Information</h2>
    <ul>
      <li><a href="#">Link 1</a></li>
    </ul>
  </aside>
</main>
```

**Good Table Markup:**
```html
<table>
  <caption>Quarterly Sales Data</caption>
  <thead>
    <tr>
      <th scope="col">Quarter</th>
      <th scope="col">Revenue</th>
      <th scope="col">Growth</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">Q1 2025</th>
      <td>$1.2M</td>
      <td>15%</td>
    </tr>
  </tbody>
</table>
```

### 1.4 Distinguishable

Make it easier for users to see and hear content.

#### Color Contrast Requirements (WCAG 2.2 Level AA)

| Content Type | Minimum Ratio | Required For |
|-------------|---------------|--------------|
| Normal text | 4.5:1 | Text < 18pt (or < 14pt bold) |
| Large text | 3:1 | Text ≥ 18pt (or ≥ 14pt bold) |
| UI components | 3:1 | Buttons, form borders, focus indicators |
| Graphics | 3:1 | Icons, chart elements |

#### Checklist

- [ ] Text has sufficient contrast (4.5:1 for normal, 3:1 for large)
- [ ] UI components have 3:1 contrast ratio
- [ ] Information is not conveyed by color alone
- [ ] Text can be resized to 200% without loss of functionality
- [ ] No horizontal scrolling at 320px viewport width
- [ ] Line height is at least 1.5 for paragraphs
- [ ] Paragraph spacing is at least 2x font size
- [ ] Letter spacing is at least 0.12x font size
- [ ] Focus indicators are visible (minimum 3:1 contrast)
- [ ] Audio has background noise control

#### Examples

**Good Color Usage:**
```html
<!-- Bad: Conveyed by color only -->
<span style="color: red;">Error: Invalid email</span>

<!-- Good: Color + icon + text -->
<span class="error">
  <svg aria-hidden="true"><use href="#error-icon"></use></svg>
  Error: Invalid email
</span>
```

**Good Contrast CSS:**
```css
/* Ensure sufficient contrast */
body {
  color: #1a1a1a; /* 16.1:1 on white */
  background: #ffffff;
}

.button {
  background: #0056b3; /* 7.5:1 with white text */
  color: #ffffff;
  border: 2px solid #003d82; /* 3.2:1 with background */
}

/* Visible focus indicator */
:focus-visible {
  outline: 3px solid #0056b3; /* 7.5:1 with white */
  outline-offset: 2px;
}

/* Responsive text sizing */
p {
  font-size: 1rem;
  line-height: 1.5;
  margin-bottom: 1.5em;
}
```

---

## Operable

User interface components and navigation must be operable.

### 2.1 Keyboard Accessible

Make all functionality available from a keyboard.

#### Checklist

- [ ] All interactive elements are keyboard accessible
- [ ] Tab order is logical and follows visual flow
- [ ] No keyboard traps (can tab in and out of all areas)
- [ ] Keyboard shortcuts don't conflict with assistive tech
- [ ] Custom controls have proper keyboard support
- [ ] Focus is visible at all times
- [ ] Skip navigation links are provided

#### Examples

**Good Keyboard Navigation:**
```html
<!-- Skip to main content link -->
<a href="#main-content" class="skip-link">
  Skip to main content
</a>

<nav>...</nav>

<main id="main-content" tabindex="-1">
  <h1>Page Content</h1>
</main>
```

```css
/* Make skip link visible on focus */
.skip-link {
  position: absolute;
  top: -40px;
  left: 0;
  background: #000;
  color: #fff;
  padding: 8px;
  z-index: 100;
}

.skip-link:focus {
  top: 0;
}
```

**Good Custom Control:**
```html
<div
  role="button"
  tabindex="0"
  aria-pressed="false"
  onkeydown="handleKeyDown(event)"
  onclick="handleClick(event)"
>
  Toggle
</div>

<script>
function handleKeyDown(event) {
  // Space or Enter activates button
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    handleClick(event);
  }
}
</script>
```

### 2.2 Enough Time

Provide users enough time to read and use content.

#### Checklist

- [ ] Time limits can be turned off, adjusted, or extended
- [ ] Moving, blinking, or scrolling content can be paused
- [ ] Auto-updating content can be paused or controlled
- [ ] Users are warned before time expires
- [ ] Session timeouts preserve data
- [ ] No content flashes more than 3 times per second

#### Examples

```html
<!-- Timer with controls -->
<div role="timer" aria-live="polite" aria-atomic="true">
  Time remaining: <span id="timer">5:00</span>
</div>

<button onclick="extendTime()">Extend time by 5 minutes</button>
<button onclick="pauseTimer()">Pause</button>

<!-- Auto-updating content with pause -->
<div aria-live="polite" aria-atomic="false">
  <button onclick="toggleUpdates()" aria-pressed="false">
    Pause live updates
  </button>
  <div id="live-content">...</div>
</div>
```

### 2.3 Seizures and Physical Reactions

Do not design content in a way that causes seizures or physical reactions.

#### Checklist

- [ ] No content flashes more than 3 times per second
- [ ] Flashing content is below flash threshold
- [ ] Motion animation can be disabled
- [ ] Parallax effects can be disabled
- [ ] Respect `prefers-reduced-motion` setting

#### Examples

```css
/* Respect user's motion preferences */
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/* Safe animation with reduced motion fallback */
.element {
  transition: transform 0.3s ease;
}

@media (prefers-reduced-motion: reduce) {
  .element {
    transition: none;
  }
}
```

### 2.4 Navigable

Provide ways to help users navigate, find content, and determine location.

#### Checklist

- [ ] Skip navigation mechanism is provided
- [ ] Page has a descriptive title
- [ ] Focus order is meaningful
- [ ] Link purpose is clear from link text or context
- [ ] Multiple ways to find pages (search, sitemap, nav)
- [ ] Headings and labels are descriptive
- [ ] Keyboard focus is visible
- [ ] Current page is indicated in navigation

#### Examples

**Good Page Title:**
```html
<title>Contact Us - Acme Corporation</title>
```

**Good Link Text:**
```html
<!-- Bad: Unclear link purpose -->
<a href="report.pdf">Click here</a> for the annual report

<!-- Good: Clear link purpose -->
<a href="report.pdf">Download 2025 Annual Report (PDF, 2.3MB)</a>
```

**Good Navigation with Current Page:**
```html
<nav aria-label="Main navigation">
  <ul>
    <li><a href="/">Home</a></li>
    <li><a href="/about">About</a></li>
    <li>
      <a href="/products" aria-current="page">Products</a>
    </li>
    <li><a href="/contact">Contact</a></li>
  </ul>
</nav>
```

### 2.5 Input Modalities

Make it easier for users to operate functionality through various inputs.

#### Checklist

- [ ] Pointer gestures have single-pointer alternative
- [ ] Pointer cancellation is supported (up event, not down)
- [ ] Labels match accessible names
- [ ] Motion actuation can be disabled
- [ ] Target size is at least 44x44 pixels (Level AAA: 44x44)

#### Examples

```css
/* Adequate touch target size */
button, a, input, select {
  min-height: 44px;
  min-width: 44px;
  padding: 12px 16px;
}

/* Exception: inline links can be smaller but should have adequate spacing */
p a {
  padding: 4px 2px;
  margin: 0 2px;
}
```

---

## Understandable

Information and the operation of the user interface must be understandable.

### 3.1 Readable

Make text content readable and understandable.

#### Checklist

- [ ] Page language is specified
- [ ] Language changes are marked
- [ ] Unusual words are defined
- [ ] Abbreviations are explained
- [ ] Reading level is appropriate (or alternative provided)
- [ ] Pronunciation is provided for ambiguous words

#### Examples

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Page Title</title>
</head>
<body>
  <p>The conference will be held in Paris.</p>

  <!-- Language change -->
  <p>The motto is <span lang="fr">Liberté, égalité, fraternité</span>.</p>

  <!-- Abbreviation -->
  <p>
    The <abbr title="World Wide Web Consortium">W3C</abbr>
    publishes web standards.
  </p>

  <!-- Definition -->
  <p>
    A <dfn>viewport</dfn> is the visible area of a web page
    in a browser window.
  </p>
</body>
</html>
```

### 3.2 Predictable

Make web pages appear and operate in predictable ways.

#### Checklist

- [ ] Focus does not trigger context changes
- [ ] Input does not trigger unexpected context changes
- [ ] Navigation is consistent across pages
- [ ] Components are identified consistently
- [ ] Changes can be requested before they happen

#### Examples

**Good Form Behavior:**
```html
<!-- Bad: Auto-submits on selection -->
<select onchange="this.form.submit()">
  <option>Choose an option</option>
</select>

<!-- Good: User explicitly submits -->
<select id="country" name="country">
  <option>Choose a country</option>
  <option>United States</option>
  <option>Canada</option>
</select>
<button type="submit">Continue</button>
```

**Good Consistent Navigation:**
```html
<!-- Same navigation structure on all pages -->
<nav aria-label="Main navigation">
  <ul>
    <li><a href="/">Home</a></li>
    <li><a href="/products">Products</a></li>
    <li><a href="/about">About</a></li>
    <li><a href="/contact">Contact</a></li>
  </ul>
</nav>
```

### 3.3 Input Assistance

Help users avoid and correct mistakes.

#### Checklist

- [ ] Error messages are clear and specific
- [ ] Labels and instructions are provided
- [ ] Errors are identified and described
- [ ] Suggestions for fixing errors are provided
- [ ] Important actions can be reversed, checked, or confirmed
- [ ] Form validation happens at appropriate times
- [ ] Required fields are clearly marked

#### Examples

**Good Error Handling:**
```html
<form>
  <div class="form-group">
    <label for="email">
      Email address <span aria-label="required">*</span>
    </label>
    <input
      type="email"
      id="email"
      name="email"
      aria-required="true"
      aria-invalid="true"
      aria-describedby="email-error"
    >
    <div id="email-error" class="error" role="alert">
      Error: Please enter a valid email address (e.g., name@example.com)
    </div>
  </div>

  <button type="submit">Submit</button>
</form>
```

**Good Confirmation Dialog:**
```html
<button onclick="showDeleteConfirm()">Delete Account</button>

<div role="alertdialog" aria-labelledby="dialog-title" aria-describedby="dialog-desc">
  <h2 id="dialog-title">Confirm Account Deletion</h2>
  <p id="dialog-desc">
    This action cannot be undone. Your account and all associated data
    will be permanently deleted.
  </p>
  <button onclick="deleteAccount()">Delete Account</button>
  <button onclick="closeDialog()">Cancel</button>
</div>
```

---

## Robust

Content must be robust enough that it can be interpreted reliably by a wide variety of user agents, including assistive technologies.

### 4.1 Compatible

Maximize compatibility with current and future user agents.

#### Checklist

- [ ] HTML is valid and well-formed
- [ ] Elements have complete start and end tags
- [ ] Elements are nested correctly
- [ ] IDs are unique
- [ ] Attributes are used correctly
- [ ] ARIA attributes are valid and used properly
- [ ] Status messages are programmatically determinable

#### Examples

**Good Status Messages:**
```html
<!-- Loading state -->
<div role="status" aria-live="polite" aria-atomic="true">
  <span class="visually-hidden">Loading...</span>
</div>

<!-- Success message -->
<div role="status" aria-live="polite">
  Form submitted successfully
</div>

<!-- Error notification (more urgent) -->
<div role="alert" aria-live="assertive">
  Connection lost. Please check your internet connection.
</div>
```

**Good ARIA Usage:**
```html
<!-- Expandable section -->
<button
  aria-expanded="false"
  aria-controls="section1"
  id="section1-button"
>
  Show Details
</button>
<div id="section1" aria-labelledby="section1-button" hidden>
  <p>Additional details...</p>
</div>
```

---

## WAI-ARIA Patterns

Common component patterns with proper ARIA implementation.

### Dialog (Modal)

```html
<button onclick="openDialog()">Open Dialog</button>

<div
  role="dialog"
  aria-labelledby="dialog-title"
  aria-describedby="dialog-desc"
  aria-modal="true"
  hidden
  id="my-dialog"
>
  <h2 id="dialog-title">Dialog Title</h2>
  <p id="dialog-desc">Dialog description and content.</p>

  <button onclick="closeDialog()">Close</button>
</div>

<script>
function openDialog() {
  const dialog = document.getElementById('my-dialog');
  const previousFocus = document.activeElement;

  dialog.hidden = false;
  dialog.querySelector('button').focus();

  // Trap focus within dialog
  dialog.addEventListener('keydown', trapFocus);

  // Store previous focus to restore later
  dialog.dataset.previousFocus = previousFocus;
}

function closeDialog() {
  const dialog = document.getElementById('my-dialog');
  dialog.hidden = true;

  // Restore focus
  const previousFocus = document.getElementById(dialog.dataset.previousFocus);
  if (previousFocus) previousFocus.focus();
}

function trapFocus(event) {
  // Implementation of focus trap
}
</script>
```

### Tabs

```html
<div class="tabs">
  <div role="tablist" aria-label="Sample Tabs">
    <button
      role="tab"
      aria-selected="true"
      aria-controls="panel-1"
      id="tab-1"
      tabindex="0"
    >
      Tab 1
    </button>
    <button
      role="tab"
      aria-selected="false"
      aria-controls="panel-2"
      id="tab-2"
      tabindex="-1"
    >
      Tab 2
    </button>
    <button
      role="tab"
      aria-selected="false"
      aria-controls="panel-3"
      id="tab-3"
      tabindex="-1"
    >
      Tab 3
    </button>
  </div>

  <div role="tabpanel" id="panel-1" aria-labelledby="tab-1" tabindex="0">
    <p>Panel 1 content</p>
  </div>
  <div role="tabpanel" id="panel-2" aria-labelledby="tab-2" tabindex="0" hidden>
    <p>Panel 2 content</p>
  </div>
  <div role="tabpanel" id="panel-3" aria-labelledby="tab-3" tabindex="0" hidden>
    <p>Panel 3 content</p>
  </div>
</div>

<script>
// Arrow key navigation between tabs
// Automatic activation on focus
// Manage aria-selected and tabindex
</script>
```

### Combobox (Autocomplete)

```html
<label for="combo-input">Choose a fruit</label>
<div class="combobox">
  <input
    type="text"
    id="combo-input"
    role="combobox"
    aria-autocomplete="list"
    aria-expanded="false"
    aria-controls="listbox"
    aria-activedescendant=""
  >
  <ul
    id="listbox"
    role="listbox"
    aria-label="Fruits"
    hidden
  >
    <li role="option" id="option-1">Apple</li>
    <li role="option" id="option-2">Banana</li>
    <li role="option" id="option-3">Cherry</li>
  </ul>
</div>
```

### Menu

```html
<button
  aria-haspopup="true"
  aria-expanded="false"
  aria-controls="menu1"
  id="menubutton"
>
  Actions
</button>

<ul role="menu" id="menu1" aria-labelledby="menubutton" hidden>
  <li role="none">
    <button role="menuitem" onclick="action1()">
      Edit
    </button>
  </li>
  <li role="none">
    <button role="menuitem" onclick="action2()">
      Delete
    </button>
  </li>
  <li role="separator"></li>
  <li role="none">
    <button role="menuitem" onclick="action3()">
      Export
    </button>
  </li>
</ul>
```

### Accordion

```html
<div class="accordion">
  <h3>
    <button
      aria-expanded="false"
      aria-controls="sect1"
      id="accordion1"
    >
      Section 1
    </button>
  </h3>
  <div id="sect1" aria-labelledby="accordion1" hidden>
    <p>Section 1 content</p>
  </div>

  <h3>
    <button
      aria-expanded="false"
      aria-controls="sect2"
      id="accordion2"
    >
      Section 2
    </button>
  </h3>
  <div id="sect2" aria-labelledby="accordion2" hidden>
    <p>Section 2 content</p>
  </div>
</div>
```

---

## Testing Checklist

### Automated Testing

#### Tools to Use

1. **axe DevTools**
   - Browser extension for Chrome, Firefox, Edge
   - Catches 57% of WCAG issues automatically
   - Provides detailed remediation guidance

2. **Lighthouse**
   - Built into Chrome DevTools
   - Comprehensive accessibility audit
   - Performance and SEO metrics included

3. **eslint-plugin-jsx-a11y**
   - Linting for React/JSX
   - Catches issues during development
   - Integrates with CI/CD

4. **Pa11y**
   - Command-line tool
   - CI/CD integration
   - Automated testing in pipelines

#### Automated Testing Checklist

- [ ] Run axe DevTools on all pages
- [ ] Run Lighthouse accessibility audit
- [ ] Configure eslint-plugin-jsx-a11y in project
- [ ] Set up Pa11y in CI/CD pipeline
- [ ] Test with HTML validator (W3C)
- [ ] Check color contrast with tools
- [ ] Validate ARIA usage

#### Example: eslint-plugin-jsx-a11y Setup

```javascript
// .eslintrc.js
module.exports = {
  extends: [
    'plugin:jsx-a11y/recommended'
  ],
  plugins: ['jsx-a11y'],
  rules: {
    'jsx-a11y/anchor-is-valid': 'error',
    'jsx-a11y/alt-text': 'error',
    'jsx-a11y/aria-props': 'error',
    'jsx-a11y/aria-role': 'error',
    'jsx-a11y/heading-has-content': 'error',
    'jsx-a11y/label-has-associated-control': 'error',
  }
};
```

#### Example: Pa11y CI Configuration

```javascript
// .pa11yci.json
{
  "defaults": {
    "standard": "WCAG2AA",
    "timeout": 10000,
    "wait": 500,
    "chromeLaunchConfig": {
      "args": ["--no-sandbox"]
    }
  },
  "urls": [
    "http://localhost:3000/",
    "http://localhost:3000/about",
    "http://localhost:3000/contact"
  ]
}
```

### Manual Testing

#### Keyboard Testing

- [ ] Navigate entire site using only keyboard
- [ ] Tab through all interactive elements
- [ ] Verify focus indicators are visible
- [ ] Check tab order is logical
- [ ] Test skip navigation links
- [ ] Ensure no keyboard traps exist
- [ ] Test all keyboard shortcuts
- [ ] Verify Esc key closes modals/dropdowns
- [ ] Test form submission with Enter key
- [ ] Check arrow key navigation in menus/tabs

**Keyboard Shortcuts Reference:**
- `Tab`: Move to next focusable element
- `Shift + Tab`: Move to previous focusable element
- `Enter`: Activate links and buttons
- `Space`: Activate buttons, toggle checkboxes
- `Arrow keys`: Navigate menus, tabs, radio groups
- `Esc`: Close dialogs, menus
- `Home/End`: Jump to first/last item in lists

#### Screen Reader Testing

Test with at least two screen readers:

**Recommended Combinations:**
- **Windows**: NVDA (free) or JAWS with Chrome/Firefox
- **macOS**: VoiceOver (built-in) with Safari
- **iOS**: VoiceOver (built-in) with Safari
- **Android**: TalkBack (built-in) with Chrome

**Screen Reader Testing Checklist:**

- [ ] All content is read in logical order
- [ ] Headings are announced correctly
- [ ] Links have meaningful descriptions
- [ ] Form fields have proper labels
- [ ] Error messages are announced
- [ ] Dynamic content changes are announced
- [ ] Images have appropriate alt text
- [ ] Tables are navigable and understandable
- [ ] Buttons clearly state their purpose
- [ ] ARIA attributes work correctly
- [ ] Lists are announced as lists
- [ ] Landmarks are identified correctly

**VoiceOver Basic Commands (macOS):**
- `Cmd + F5`: Turn on/off
- `VO + A`: Read all
- `VO + Right Arrow`: Next item
- `VO + Left Arrow`: Previous item
- `VO + U`: Rotor (headings, links, forms)
- `VO + Space`: Activate element

**NVDA Basic Commands (Windows):**
- `Ctrl + Alt + N`: Start NVDA
- `Insert + Down Arrow`: Read all
- `H`: Next heading
- `K`: Next link
- `F`: Next form field
- `Insert + F7`: Elements list

#### Visual Testing

- [ ] Test at 200% browser zoom
- [ ] Test at 320px viewport width (mobile)
- [ ] Verify no horizontal scrolling required
- [ ] Check focus indicators are visible
- [ ] Verify color contrast meets minimums
- [ ] Test with Windows High Contrast mode
- [ ] Test with dark mode/light mode
- [ ] Verify content reflows properly
- [ ] Check spacing and readability
- [ ] Test with different font sizes

#### Color Contrast Testing Tools

- **Chrome DevTools**: Built-in contrast checker
- **Color Contrast Analyzer (CCA)**: Desktop app
- **WebAIM Contrast Checker**: Online tool
- **Stark**: Figma/Sketch plugin

#### Browser/Device Matrix

Minimum testing matrix:

| Browser | Version | Screen Reader |
|---------|---------|---------------|
| Chrome | Latest | NVDA (Windows) |
| Firefox | Latest | NVDA (Windows) |
| Safari | Latest | VoiceOver (macOS) |
| Edge | Latest | NVDA (Windows) |
| Safari iOS | Latest | VoiceOver |
| Chrome Android | Latest | TalkBack |

---

## Tools and Resources

### Testing Tools

**Automated:**
- [axe DevTools](https://www.deque.com/axe/devtools/)
- [Lighthouse](https://developers.google.com/web/tools/lighthouse)
- [Pa11y](https://pa11y.org/)
- [WAVE](https://wave.webaim.org/)
- [HTML CodeSniffer](https://squizlabs.github.io/HTML_CodeSniffer/)

**Manual:**
- [Color Contrast Analyzer](https://www.tpgi.com/color-contrast-checker/)
- [NVDA Screen Reader](https://www.nvaccess.org/)
- [JAWS Screen Reader](https://www.freedomscientific.com/products/software/jaws/)
- [HeadingsMap Browser Extension](https://chromewebstore.google.com/detail/headingsmap/)

**Development:**
- [eslint-plugin-jsx-a11y](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y)
- [axe-core](https://github.com/dequelabs/axe-core)
- [jest-axe](https://github.com/nickcolley/jest-axe)
- [cypress-axe](https://github.com/component-driven/cypress-axe)

### Learning Resources

- [WCAG 2.2 Guidelines](https://www.w3.org/WAI/WCAG22/quickref/)
- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [WebAIM](https://webaim.org/)
- [A11y Project Checklist](https://www.a11yproject.com/checklist/)
- [Inclusive Components](https://inclusive-components.design/)
- [MDN Accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility)

### Quick Reference Cards

**ARIA Roles:**
```
Landmark roles: banner, main, navigation, complementary, contentinfo
Widget roles: button, checkbox, dialog, tab, tabpanel, menu, menuitem
Document roles: article, definition, directory, document, list, listitem
```

**ARIA States and Properties:**
```
aria-label: Defines a string value that labels an element
aria-labelledby: References the ID(s) of labeling element(s)
aria-describedby: References the ID(s) of describing element(s)
aria-hidden: Removes element from accessibility tree
aria-live: Announces dynamic changes (off, polite, assertive)
aria-expanded: Indicates if element is expanded
aria-selected: Indicates if element is selected
aria-checked: Indicates checkbox/radio state
aria-pressed: Indicates toggle button state
aria-invalid: Indicates field has validation error
aria-required: Indicates field is required
```

---

## Pre-Launch Accessibility Checklist

Before launching any feature or page:

### Code Quality
- [ ] HTML validates with no errors
- [ ] ARIA attributes are valid and necessary
- [ ] No duplicate IDs exist
- [ ] Semantic HTML is used throughout
- [ ] Forms use proper labels and fieldsets

### Keyboard & Focus
- [ ] All functionality keyboard accessible
- [ ] Focus order is logical
- [ ] Focus indicators clearly visible
- [ ] No keyboard traps
- [ ] Skip links work correctly

### Screen Reader
- [ ] Tested with 2+ screen readers
- [ ] All content accessible
- [ ] Dynamic changes announced
- [ ] Landmarks properly labeled
- [ ] Headings form logical outline

### Visual
- [ ] Color contrast meets AA standards
- [ ] Works at 200% zoom
- [ ] No horizontal scroll at 320px
- [ ] Content reflows properly
- [ ] Information not conveyed by color alone

### Automated Testing
- [ ] axe DevTools shows no violations
- [ ] Lighthouse accessibility score ≥ 95
- [ ] ESLint a11y rules pass
- [ ] Pa11y CI tests pass
- [ ] HTML validates

### Documentation
- [ ] Accessibility features documented
- [ ] Known issues logged
- [ ] Remediation plan for issues
- [ ] Testing results recorded

---

## Getting Help

- **Ask questions**: [WebAIM Discussion List](https://webaim.org/discussion/)
- **File issues**: Report accessibility bugs to product teams
- **Consult experts**: Consider accessibility audit for complex projects
- **Stay current**: Follow [W3C WAI](https://www.w3.org/WAI/) for updates
