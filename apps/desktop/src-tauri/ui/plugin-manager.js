/**
 * Desktop plugin manager.
 *
 * The page lists the profile's plugins and drives the shell's transactions;
 * every action stops, changes, and restarts the backend through the shell, so
 * the page only reports what the shell answered. `window.dsh` is installed by
 * the shell before this module runs.
 */

const { messages } = await window.dsh.locale()

/** Replace `{name}`-style placeholders in one shell message. */
function format(message, values) {
  return message.replace(/\{([^{}]+)\}/g, (placeholder, key) => values[key] ?? placeholder)
}

const title = document.getElementById('title')
const description = document.getElementById('description')
const refresh = document.getElementById('refresh')
const install = document.getElementById('install')
const specLabel = document.getElementById('spec-label')
const spec = document.getElementById('spec')
const installButton = document.getElementById('install-button')
const status = document.getElementById('status')
const list = document.getElementById('plugins')

document.title = messages.pluginWindowTitle
title.textContent = messages.pluginManagerTitle
description.textContent = messages.pluginManagerDescription
refresh.textContent = messages.refresh
specLabel.textContent = messages.npmPackage
installButton.textContent = messages.install
status.textContent = messages.loadingPlugins
spec.placeholder = messages.npmPackage

/** Run one shell transaction, reporting its progress and outcome. */
async function run(progress, action) {
  status.textContent = progress
  try {
    await action()
    status.textContent = messages.operationComplete
  } catch (error) {
    status.textContent = error === null || error === undefined ? messages.unknownError : String(error)
  }
  await render()
}

/** Build one row: name, version, and the actions that row supports. */
function row(plugin) {
  const item = document.createElement('li')
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = plugin.name
  const version = document.createElement('span')
  version.className = 'version muted'
  version.textContent = plugin.version
  const actions = document.createElement('span')
  actions.className = 'actions'

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.textContent = plugin.enabled ? messages.disable : messages.enable
  toggle.addEventListener('click', () => {
    void run(messages.changingActivation, () => window.dsh.plugins.toggle(plugin.name, !plugin.enabled))
  })
  if (!plugin.enabled) {
    const disabled = document.createElement('span')
    disabled.className = 'muted'
    disabled.textContent = messages.disabled
    actions.append(disabled)
  }

  const update = document.createElement('button')
  update.type = 'button'
  update.textContent = messages.update
  update.addEventListener('click', () => {
    const target = window.prompt(format(messages.targetVersion, { name: plugin.name }), plugin.version)
    if (target === null || target === '') return
    void run(format(messages.updating, { name: plugin.name }), () => window.dsh.plugins.update(plugin.name, target))
  })

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.textContent = messages.remove
  remove.addEventListener('click', () => {
    void run(format(messages.removing, { name: plugin.name }), () => window.dsh.plugins.remove(plugin.name))
  })

  actions.prepend(toggle)
  actions.append(update, remove)
  item.append(name, version, actions)
  return item
}

/** Read the profile and render it. */
async function render() {
  let plugins
  try {
    plugins = await window.dsh.plugins.list()
  } catch (error) {
    status.textContent = String(error)
    return
  }
  list.replaceChildren()
  if (plugins.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'muted'
    empty.textContent = messages.noPlugins
    list.append(empty)
    return
  }
  for (const plugin of plugins) list.append(row(plugin))
}

refresh.addEventListener('click', () => {
  status.textContent = messages.refreshing
  void render().then(() => { status.textContent = messages.refreshed })
})

install.addEventListener('submit', (event) => {
  event.preventDefault()
  const value = spec.value.trim()
  if (value === '') return
  spec.value = ''
  void run(format(messages.installing, { spec: value }), () => window.dsh.plugins.add(value))
})

await render()
