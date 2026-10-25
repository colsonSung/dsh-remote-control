/**
 * Client half of `@local/remote-control`: the Settings page named
 * "Remote Control".
 *
 * The page mirrors Kimi Code's panel — a switch, a QR code that carries the
 * access URL, a copy/open pair, a security note, and a "Remote device
 * management" list — and talks to the Host over the generic Connection RPC
 * channel `/remote-control`.
 */

window.__ModuleLoader__.load({
  id: '@local/remote-control',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The locale namespace this page owns. */
    const NS = 'remote-control'

    /** The exact Fetch route the Host serves. */
    const ROUTE = '/api/remote-control'

    const DICTIONARY = {
      en: {
        nav: 'Remote Control',
        title: 'Remote Control',
        subtitle: 'Once turned on, open the link on another device to control the agent on this computer',
        on: 'Remote Control is on',
        off: 'Remote Control is off',
        qrCaption: 'Scan with your phone to open',
        copyLink: 'Copy link',
        copied: 'Copied',
        openLink: 'Open link',
        security: 'Keep this computer awake and online. The phone asks for the access code before it can control this agent — share neither the link nor the code.',
        passcode: 'Access code',
        passcodeHint: 'The phone must type this 8-digit code once before it can control the agent. It never travels in the link.',
        copyPasscode: 'Copy code',
        rotatePasscode: 'Change code',
        passcodeRotated: 'A new access code is in use; the old one no longer works.',
        phones: 'Devices that connected',
        phonesHint: 'A device that is trusted skips the access code from then on.',
        phoneTrusted: 'Trusted',
        phoneTrust: 'Trust this device',
        phoneLastSeen: 'Last seen',
        phoneFirstSeen: 'First seen',
        removePhone: 'Remove device',
        removePhoneConfirm: 'Remove this device? It will have to enter the access code again.',
        phoneRemoved: 'The device was removed.',
        devices: 'Remote device management',
        refresh: 'Refresh',
        thisComputer: 'This computer',
        online: 'Online',
        offline: 'Offline',
        rename: 'Rename',
        takeOffline: 'Take offline',
        takeOfflineHint: 'Disconnects it now; it reconnects on its own.',
        revoke: 'Revoke access',
        revokeHint: 'Refuses this device until you restore it.',
        restore: 'Restore access',
        restoreHint: 'Lets the device register again.',
        revoked: 'Revoked',
        renamed: 'Device renamed',
        takenOffline: 'Device taken offline',
        failed: 'Remote control failed',
        relayUrl: 'Relay server',
        relayUrlHint: 'Leave empty to use the relay bundled with this app (local network only).',
        relayUrlPlaceholder: 'https://relay.example.com',
        applyRelay: 'Use relay',
        publicAddress: 'Public address',
        publicAddressHint: 'Optional: the origin a phone opens, when a tunnel or reverse proxy fronts the relay. Empty means this computer\'s local network address.',
        publicAddressPlaceholder: 'https://rc.example.com',
        applyAddress: 'Use address',
        fingerprint: 'Credential',
        noLink: 'No access link yet — turn Remote Control on.',
        connecting: 'Connecting to the relay…',
        restartRequired: 'The host plugin is not active yet — restart the Harness to load it.',
      },
      zh: {
        nav: '远程控制',
        title: '远程控制',
        subtitle: '开启后，在其他设备上打开链接即可控制本机上的智能体',
        on: '远程控制已开启',
        off: '远程控制已关闭',
        qrCaption: '用手机扫码打开',
        copyLink: '复制链接',
        copied: '已复制',
        openLink: '打开链接',
        security: '请保持电脑唤醒并联网。手机需要先输入访问码才能控制本机智能体——链接和访问码都不要外传。',
        passcode: '访问码',
        passcodeHint: '手机首次访问需输入这 8 位数字，之后才会话保持登录。访问码不会出现在链接里。',
        copyPasscode: '复制访问码',
        rotatePasscode: '更换访问码',
        passcodeRotated: '已启用新访问码，旧访问码立即失效。',
        phones: '访问过的设备',
        phonesHint: '标记为信任后，该设备以后可以免访问码登录。',
        phoneTrusted: '已信任',
        phoneTrust: '信任此设备',
        phoneLastSeen: '最近访问',
        phoneFirstSeen: '首次访问',
        removePhone: '移除设备',
        removePhoneConfirm: '移除该设备？它之后需要重新输入访问码。',
        phoneRemoved: '该设备已被移除。',
        devices: '远程设备管理',
        refresh: '刷新',
        thisComputer: '本机',
        online: '在线',
        offline: '离线',
        rename: '重命名',
        takeOffline: '下线',
        takeOfflineHint: '立刻断开它，设备会自己重连。',
        revoke: '撤销访问',
        revokeHint: '持续拒绝该设备，直到你恢复为止。',
        restore: '恢复访问',
        restoreHint: '允许该设备重新接入。',
        revoked: '已撤销',
        renamed: '设备已重命名',
        takenOffline: '设备已下线',
        failed: '远程控制失败',
        relayUrl: '中继服务地址',
        relayUrlHint: '留空则使用内置中继（仅局域网可达）。',
        relayUrlPlaceholder: 'https://relay.example.com',
        applyRelay: '使用该中继',
        publicAddress: '公网地址',
        publicAddressHint: '可选：当隧道或反向代理挡在中继前面时，填手机实际打开的地址；留空则使用本机的局域网地址。',
        publicAddressPlaceholder: 'https://rc.example.com',
        applyAddress: '使用该地址',
        fingerprint: '凭据',
        noLink: '还没有访问链接 —— 请先开启远程控制。',
        connecting: '正在连接中继服务…',
        restartRequired: '宿主插件尚未生效 —— 请重启 Harness 以加载。',
      },
    }

    const CSS = `
.rc-section{display:flex;flex-direction:column;gap:16px;max-width:720px;color:var(--dsw-alias-label-primary)}
.rc-card{display:flex;flex-direction:column;gap:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:16px;background:var(--dsw-alias-bg-layer-1)}
.rc-row{display:flex;justify-content:space-between;align-items:center;gap:24px}
.rc-headline{font-size:14px;line-height:20px;font-weight:500}
.rc-description{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:4px}
.rc-switch{position:relative;width:40px;height:22px;border-radius:11px;border:none;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .15s ease;flex:none}
.rc-switch[data-on="true"]{background:var(--dsw-alias-state-business-primary)}
.rc-switch[data-disabled="true"]{opacity:.5;cursor:not-allowed}
.rc-thumb{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-switch-thumb,var(--dsw-alias-bg-layer-1));transition:transform .15s ease}
.rc-switch[data-on="true"] .rc-thumb{transform:translateX(18px)}
.rc-qr{display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:4px}
.rc-qr svg{width:180px;height:180px;background:#fff;padding:8px;border-radius:8px}
.rc-caption{font-size:12px;color:var(--dsw-alias-label-secondary)}
.rc-actions{display:flex;gap:8px;justify-content:center}
.rc-button{font-size:12px;line-height:16px;padding:6px 12px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.rc-button:hover{background:var(--dsw-alias-bg-layer-3)}
.rc-button[data-disabled="true"]{opacity:.5;cursor:not-allowed}
.rc-note{display:flex;gap:6px;align-items:flex-start;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.rc-devices{display:flex;flex-direction:column;gap:8px}
.rc-devices-head{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:500}
.rc-device{display:flex;justify-content:space-between;align-items:center;gap:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px 16px;background:var(--dsw-alias-bg-layer-1)}
.rc-device-main{display:flex;flex-direction:column;gap:4px;min-width:0}
.rc-device-name{display:flex;align-items:center;gap:8px;font-size:13px}
.rc-badge{font-size:11px;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:1px 6px}
.rc-device-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}
.rc-device-right{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rc-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.rc-dot[data-status="offline"]{background:var(--dsw-alias-label-tertiary)}
.rc-menu{position:relative}
.rc-menu-list{position:absolute;right:0;top:22px;min-width:140px;display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-alias-elevation-2);z-index:20;overflow:hidden}
.rc-menu-item{font-size:12px;padding:8px 12px;text-align:left;border:none;background:none;color:var(--dsw-alias-label-primary);cursor:pointer}
.rc-menu-item:hover{background:var(--dsw-alias-bg-layer-3)}
.rc-menu-item[data-danger="true"]{color:var(--dsw-alias-state-error-primary)}
.rc-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.rc-field{display:flex;flex-direction:column;gap:6px}
.rc-input{font-size:12px;padding:6px 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);min-width:260px}
.rc-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rc-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;letter-spacing:.28em;padding:6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.rc-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
`

    /** The plugin context, captured for the components rendered later. */
    let hostCtx

    /**
     * Call one Host endpoint over the exact Fetch route the host registers.
     * @param {string} endpoint
     * @param {Record<string, unknown>} [payload]
     * @returns {Promise<{ ok: boolean, value?: unknown, error?: unknown }>}
     */
    function call(endpoint, payload) {
      return fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: endpoint, payload: payload ?? {} }),
      }).then((response) => {
        // A fresh installation answers the SPA fallback until the host has
        // loaded the plugin, which happens on the next app start.
        if (response.status === 404 || response.status === 405) {
          throw new Error('restart-required')
        }
        return response.json()
      })
    }

    /**
     * The message of one failed RPC result.
     * @param {any} result
     * @param {string} fallback
     * @returns {string}
     */
    function messageOf(result, fallback) {
      const error = result?.error
      if (typeof error === 'string') return error
      if (typeof error?.message === 'string') return error.message
      return fallback
    }

    /**
     * Copy text to the clipboard.
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    function copyText(text) {
      if (navigator.clipboard?.writeText === undefined) return Promise.resolve(false)
      return navigator.clipboard.writeText(text).then(() => true).catch(() => false)
    }

    /**
     * Format an ISO timestamp for the device list.
     *
     * @param {string | undefined} value
     * @returns {string}
     */
    function formatTime(value) {
      if (typeof value !== 'string' || value.length === 0) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleString()
    }

    /**
     * A switch that reports the next value.
     * @param {{checked: boolean, label: string, disabled?: boolean, onChange: (next: boolean) => void}} props
     */
    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked,
        'aria-label': props.label,
        className: 'rc-switch',
        'data-on': props.checked ? 'true' : 'false',
        'data-disabled': props.disabled === true ? 'true' : 'false',
        disabled: props.disabled === true,
        onClick: () => props.onChange(!props.checked),
      }, h('span', { className: 'rc-thumb' }))
    }

    /**
     * One row of "Remote device management".
     * @param {{device: Record<string, any>, t: Function, onRename: Function, onOffline: Function}} props
     */
    function DeviceRow(props) {
      const [open, setOpen] = React.useState(false)
      const device = props.device
      const status = device.status === 'online' ? props.t('online') : props.t('offline')
      return h('div', { className: 'rc-device' },
        h('div', { className: 'rc-device-main' },
          h('div', { className: 'rc-device-name' },
            h('span', null, device.alias),
            device.isThisComputer === true ? h('span', { className: 'rc-badge' }, props.t('thisComputer')) : null,
            device.revoked === true ? h('span', { className: 'rc-badge' }, props.t('revoked')) : null),
          h('div', { className: 'rc-device-sub' },
            `${device.platform} - dsh-desktop/${device.clientVersion}`)),
        h('div', { className: 'rc-device-right' },
          h('span', { className: 'rc-dot', 'data-status': device.status }),
          h('span', null, status),
          h('div', { className: 'rc-menu' },
            h('button', {
              type: 'button',
              className: 'rc-button',
              'aria-label': 'device actions',
              onClick: () => setOpen(!open),
            }, '⋯'),
            open === true
              ? h('div', { className: 'rc-menu-list' },
                h('button', {
                  type: 'button',
                  className: 'rc-menu-item',
                  onClick: () => { setOpen(false); props.onRename(device) },
                }, props.t('rename')),
                h('button', {
                  type: 'button',
                  className: 'rc-menu-item',
                  title: props.t('takeOfflineHint'),
                  onClick: () => { setOpen(false); props.onOffline(device) },
                }, props.t('takeOffline')),
                device.revoked === true
                  ? h('button', {
                    type: 'button',
                    className: 'rc-menu-item',
                    title: props.t('restoreHint'),
                    onClick: () => { setOpen(false); props.onRevoke(device, false) },
                  }, props.t('restore'))
                  : h('button', {
                    type: 'button',
                    className: 'rc-menu-item',
                    'data-danger': 'true',
                    title: props.t('revokeHint'),
                    onClick: () => { setOpen(false); props.onRevoke(device, true) },
                  }, props.t('revoke')))
              : null)))
    }

    /**
     * One phone that connected: its name, when it was last seen, the trust
     * switch, and a menu with the actions.
     *
     * @param {{phone: any, t: Function, busy: boolean, onTrust: (trusted: boolean) => void, onRename: (alias: string) => void, onRemove: () => void}} props
     */
    function PhoneRow(props) {
      const [open, setOpen] = React.useState(false)
      const phone = props.phone
      const t = props.t
      return h('div', { className: 'rc-device' },
        h('div', { className: 'rc-device-main' },
          h('div', { className: 'rc-device-name' },
            h('span', null, phone.label || phone.id),
            phone.trusted === true ? h('span', { className: 'rc-badge' }, t('phoneTrusted')) : null),
          h('div', { className: 'rc-device-sub' },
            `${t('phoneLastSeen')}: ${formatTime(phone.lastSeenAt)}`)),
        h('div', { className: 'rc-device-right' },
          h(Switch, {
            checked: phone.trusted === true,
            label: `${phone.label || phone.id} — ${t('phoneTrust')}`,
            disabled: props.busy === true,
            onChange: props.onTrust,
          }),
          h('div', { className: 'rc-menu' },
            h('button', {
              type: 'button',
              className: 'rc-button',
              'aria-label': t('removePhone'),
              onClick: () => setOpen(!open),
            }, '⋯'),
            open === true
              ? h('div', { className: 'rc-menu-list' },
                h('button', {
                  type: 'button',
                  className: 'rc-menu-item',
                  onClick: () => {
                    setOpen(false)
                    const alias = window.prompt(t('rename'), phone.label || '')
                    if (alias !== null && alias.trim().length > 0) props.onRename(alias.trim())
                  },
                }, t('rename')),
                h('button', {
                  type: 'button',
                  className: 'rc-menu-item',
                  'data-danger': 'true',
                  onClick: () => { setOpen(false); props.onRemove() },
                }, t('removePhone')))
              : null)))
    }

    /**
     * The "Remote Control" settings page.
     * @param {{t: Function}} props
     */
    function RemoteControlSection(props) {
      const t = props.t
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [copied, setCopied] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [relayUrl, setRelayUrl] = React.useState('')
      const [publicAddress, setPublicAddress] = React.useState('')

      const refresh = React.useCallback(() => {
        call('status').then((result) => {
          if (result?.ok === true) {
            setStatus(result.value)
            setRelayUrl(result.value.relayUrl ?? '')
            setPublicAddress(result.value.publicAddress ?? '')
          } else {
            setError(messageOf(result, t('failed')))
          }
        }).catch((cause) => {
          setError(cause instanceof Error && cause.message === 'restart-required' ? t('restartRequired') : String(cause))
        })
      }, [t])

      React.useEffect(() => {
        refresh()
        const timer = window.setInterval(refresh, 3000)
        return () => window.clearInterval(timer)
      }, [refresh])

      const run = React.useCallback((endpoint, payload) => {
        setBusy(true)
        setError(null)
        return call(endpoint, payload).then((result) => {
          setBusy(false)
          if (result?.ok === true) {
            if (result.value?.devices !== undefined) setStatus(result.value)
            else refresh()
            return true
          }
          setError(messageOf(result, t('failed')))
          return false
        }).catch((cause) => {
          setBusy(false)
          setError(cause instanceof Error && cause.message === 'restart-required' ? t('restartRequired') : String(cause))
          return false
        })
      }, [refresh, t])

      const devices = status?.devices ?? []
      const publicUrl = status?.publicUrl

      return h('div', { className: 'rc-section' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'rc-card' },
          h('div', { className: 'rc-row' },
            h('div', null,
              h('div', { className: 'rc-headline' }, status?.enabled === true ? t('on') : t('off')),
              h('div', { className: 'rc-description' }, t('subtitle'))),
            h(Switch, {
              checked: status?.enabled === true,
              label: t('title'),
              disabled: busy === true,
              onChange: (next) => { run('setEnabled', { enabled: next }) },
            })),
          status?.enabled === true && publicUrl === undefined
            ? h('div', { className: 'rc-muted' }, t('connecting'))
            : null,
          status?.enabled === true && publicUrl !== undefined
            ? h('div', { className: 'rc-qr' },
              h('div', { dangerouslySetInnerHTML: { __html: status.qrSvg ?? '' } }),
              h('div', { className: 'rc-caption' }, t('qrCaption')),
              h('div', { className: 'rc-actions' },
                h('button', {
                  type: 'button',
                  className: 'rc-button',
                  onClick: () => {
                    copyText(publicUrl).then((ok) => {
                      if (!ok) return
                      setCopied(true)
                      window.setTimeout(() => setCopied(false), 1500)
                    })
                  },
                }, copied === true ? t('copied') : t('copyLink')),
                h('button', {
                  type: 'button',
                  className: 'rc-button',
                  onClick: () => window.open(publicUrl, '_blank', 'noopener,noreferrer'),
                }, t('openLink'))))
            : null,
          status?.passcode !== undefined
            ? h('div', { className: 'rc-field' },
              h('div', { className: 'rc-headline' }, t('passcode')),
              h('div', { className: 'rc-description' }, t('passcodeHint')),
              h('div', { className: 'rc-inline' },
                h('code', { className: 'rc-code' }, status.passcode),
                h('button', {
                  type: 'button',
                  className: 'rc-button',
                  onClick: () => {
                    copyText(status.passcode).then((ok) => {
                      if (!ok) return
                      setCopied(true)
                      window.setTimeout(() => setCopied(false), 1500)
                    })
                  },
                }, copied === true ? t('copied') : t('copyPasscode')),
                h('button', {
                  type: 'button',
                  className: 'rc-button',
                  disabled: busy === true,
                  onClick: () => {
                    run('rotatePasscode', {}).then((ok) => {
                      if (ok) setNotice(t('passcodeRotated'))
                    })
                  },
                }, t('rotatePasscode'))))
            : null,
          h('div', { className: 'rc-note' }, `ⓘ ${t('security')}`),
          error !== null ? h('div', { className: 'rc-error', role: 'alert' }, error) : null),

        h('div', { className: 'rc-devices' },
          h('div', { className: 'rc-devices-head' },
            h('span', null, t('devices')),
            h('button', { type: 'button', className: 'rc-button', onClick: refresh }, t('refresh'))),
          devices.map((device) => h(DeviceRow, {
            key: device.deviceId,
            device,
            t,
            onRename: (target) => {
              const alias = window.prompt(t('rename'), target.alias)
              if (alias === null || alias.trim().length === 0) return
              run('renameDevice', { deviceId: target.deviceId, alias: alias.trim() })
                .then((ok) => { if (ok) setNotice(t('renamed')) })
            },
            onOffline: (target) => {
              run('takeOffline', { deviceId: target.deviceId })
                .then((ok) => { if (ok) setNotice(t('takenOffline')) })
            },
          })),
          notice !== null ? h('div', { className: 'rc-muted' }, notice) : null),

        h('div', { className: 'rc-devices' },
          h('div', { className: 'rc-devices-head' },
            h('span', null, t('phones'))),
          h('div', { className: 'rc-description' }, t('phonesHint')),
          (status?.phones ?? []).length === 0
            ? h('div', { className: 'rc-muted' }, '—')
            : (status?.phones ?? []).map((phone) => h(PhoneRow, {
              key: phone.id,
              phone,
              t,
              busy,
              onTrust: (trusted) => { run('setPhoneTrust', { phoneId: phone.id, trusted }) },
              onRename: (alias) => { run('renamePhone', { phoneId: phone.id, alias }) },
              onRemove: () => {
                // Removing a device is destructive: it has to enter the access
                // code again, so ask first.
                if (!window.confirm(t('removePhoneConfirm'))) return
                run('removePhone', { phoneId: phone.id }).then((ok) => {
                  if (ok) setNotice(t('phoneRemoved'))
                })
              },
            }))),
        h('div', { className: 'rc-field' },
          h('div', { className: 'rc-headline' }, t('relayUrl')),
          h('div', { className: 'rc-description' }, t('relayUrlHint')),
          h('div', { className: 'rc-inline' },
            h('input', {
              className: 'rc-input',
              value: relayUrl,
              placeholder: t('relayUrlPlaceholder'),
              onChange: (event) => setRelayUrl(event.target.value),
            }),
            h('button', {
              type: 'button',
              className: 'rc-button',
              disabled: busy === true,
              onClick: () => run('setRelayUrl', { url: relayUrl }),
            }, t('applyRelay'))),
          h('div', { className: 'rc-field' },
            h('div', { className: 'rc-headline' }, t('publicAddress')),
            h('div', { className: 'rc-description' }, t('publicAddressHint')),
            h('div', { className: 'rc-inline' },
              h('input', {
                className: 'rc-input',
                value: publicAddress,
                placeholder: t('publicAddressPlaceholder'),
                onChange: (event) => setPublicAddress(event.target.value),
              }),
              h('button', {
                type: 'button',
                className: 'rc-button',
                disabled: busy === true,
                onClick: () => run('setPublicAddress', { url: publicAddress }),
              }, t('applyAddress')))),
          status?.fingerprint !== undefined
            ? h('div', { className: 'rc-muted' }, `${t('fingerprint')}: ${status.fingerprint}`)
            : null))
    }

    /** Below this width the shipped layout turns the sidebar into phone mode. */
    const NARROW_BREAKPOINT = 1024

    /**
     * The frame element the layout renders.
     *
     * It is the only element carrying an inline grid definition, and its
     * `data-sidebar-collapsed` flag is the layout's own collapsed state (the
     * sidebar column is width 0 on darwin when that flag is set).
     * @returns {HTMLElement | null}
     */
    function layoutFrame() {
      return document.querySelector('[style*="grid-template-columns"]')
    }

    /**
     * Whether the layout is in its narrow (phone) mode.
     * @returns {boolean}
     */
    function isNarrowViewport() {
      return window.innerWidth < NARROW_BREAKPOINT
    }

    /**
     * Collapse the sidebar when it is expanded on a phone.
     *
     * The shipped layout expands the sidebar through `narrowExpanded` and only
     * resets that flag when the viewport crosses the breakpoint, so a Session
     * opened from the sidebar leaves the conversation squeezed into a sliver.
     * Closing it once the navigation has settled gives back the full width.
     * @returns {void}
     */
    function collapseSidebarIfNeeded() {
      if (!isNarrowViewport()) return
      const frame = layoutFrame()
      if (frame === null) return
      if (frame.hasAttribute('data-sidebar-collapsed')) return
      // `ctx.layout` is a service this plugin does not inject, so read it the
      // optional way; a plain property access throws instead of returning
      // undefined when the service is outside the plugin's dependency set.
      const layout = hostCtx?.get?.('layout')
      if (typeof layout?.toggleSidebar !== 'function') return
      layout.toggleSidebar()
      console.debug('[remote-control] phone sidebar: collapsed after navigation')
    }

    /**
     * Attempt a collapse after the browser has painted the new layout.
     * @param {number} [delay]
     * @returns {void}
     */
    function scheduleCollapse(delay = 0) {
      window.setTimeout(() => {
        window.requestAnimationFrame(() => collapseSidebarIfNeeded())
      }, delay)
    }

    /**
     * Install the phone behaviour: a navigation closes the expanded sidebar.
     *
     * Two signals: the workspace service's session entry points, which are
     * precise, and the document title, which the layout derives from the
     * active panel and Session and therefore covers every other route.
     * @param {any} ctx
     * @returns {() => void}
     */
    function installMobileSidebar(ctx) {
      console.debug('[remote-control] phone sidebar: installed')
      const restores = []
      const workspace = ctx.get('uiWorkspace') ?? ctx.uiWorkspace
      for (const method of ['openSession', 'startSession', 'openWorkspace']) {
        const original = workspace?.[method]
        if (typeof original !== 'function') continue
        const wrapped = function patchedNavigation(...args) {
          const result = original.apply(this, args)
          scheduleCollapse(0)
          scheduleCollapse(260)
          return result
        }
        try {
          workspace[method] = wrapped
          const installed = workspace[method] === wrapped
          if (installed) {
            console.debug(`[remote-control] phone sidebar: wrapped uiWorkspace.${method}`)
            restores.push(() => {
              if (workspace[method] === wrapped) workspace[method] = original
            })
          } else {
            console.debug(`[remote-control] phone sidebar: could not wrap uiWorkspace.${method}`)
          }
        } catch (error) {
          // A frozen service: the title observer below still covers navigation.
          console.debug('[remote-control] phone sidebar: wrap failed', String(error))
        }
      }

      // Tapping inside the expanded menu dismisses it, the way a phone menu
      // behaves: the layout keeps the menu expanded over the conversation
      // until something inside it is used.
      const onPointerDown = (event) => {
        if (!isNarrowViewport()) return
        const frame = layoutFrame()
        if (frame === null || frame.hasAttribute('data-sidebar-collapsed')) return
        const target = event.target
        if (!(target instanceof Element)) return
        const column = frame.firstElementChild
        if (column === null || !column.contains(target)) return
        // The toggle itself must keep working as a toggle.
        const control = target.closest('button,[role="button"]')
        const label = control?.getAttribute('aria-label') ?? ''
        if (/^(open|close|hide|show|toggle)\s+sidebar$/i.test(label)) return
        scheduleCollapse(0)
        scheduleCollapse(280)
      }
      document.addEventListener('pointerdown', onPointerDown, true)
      restores.push(() => document.removeEventListener('pointerdown', onPointerDown, true))

      const title = document.querySelector('title')
      if (title !== null) {
        const observer = new MutationObserver(() => scheduleCollapse(120))
        observer.observe(title, { childList: true, characterData: true, subtree: true })
        restores.push(() => observer.disconnect())
      }

      // Crossing the breakpoint resets the layout's own flag; a rotation or a
      // window resize inside phone width must not leave the menu expanded.
      const onResize = () => scheduleCollapse(120)
      window.addEventListener('resize', onResize)
      restores.push(() => window.removeEventListener('resize', onResize))

      return () => {
        for (const restore of restores) restore()
      }
    }

    return {
      inject: ['slots', 'locale', 'connection', 'layout', 'uiWorkspace'],
      apply(ctx) {
        hostCtx = ctx
        // The dictionary must live on the plugin's fiber: an unscoped
        // registration survives a reload and the next one throws "locale
        // namespace already has locale en", which fails the whole plugin.
        // A hot reload can apply this plugin twice in one page, so a second
        // registration is tolerated instead of fatal: the dictionaries of the
        // first one are still in place.
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, DICTIONARY)
          } catch (error) {
            console.warn('[remote-control] the locale namespace is already registered', error)
            return () => {}
          }
        }, 'remote-control: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.slots.inject('settings.section', () => {
          try {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'remote-control',
              order: 25,
              locale: NS,
              label: () => t('nav'),
            }, RemoteControlSection)
          } catch (error) {
            console.warn('[remote-control] the settings section is already registered', error)
            return () => {}
          }
        }), 'remote-control: settings section')
        ctx.effect(() => installMobileSidebar(ctx), 'remote-control: phone sidebar')
      },
    }
  },
})
