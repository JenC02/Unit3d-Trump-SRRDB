// ==UserScript==
// @name         Unit3d Trump Reasons & SRRDB Seach Button
// @namespace    Unit3d-Trump-SRRDB
// @version      0.3.1
// @description  Display torrent trump reasons and add SRRDB release links.
// @author       <OWNER>
// @homepageURL  <REPO_URL>
// @supportURL   <REPO_URL>/issues
// @downloadURL  <RAW_SCRIPT>
// @updateURL    <RAW_SCRIPT>
// @match        https://*/torrents*
// @run-at       document-idle
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
    'use strict';

    const TRUMP_PREFIX = /^This torrent is trumpable for the following reason:\s*/i;
    const NFO_REGEX = /nfo/i;
    const DETAIL_PATH_REGEX = /^\/torrents\/\d+\/?$/;

    const releaseCache = new Map();

    // ============================================================
    // Settings
    // ============================================================

    const defaults = {
        showReason: true,
        showButton: true,
        buttonOnlyForNfo: true
    };

    const settings = Object.fromEntries(
        Object.entries(defaults).map(([key, value]) => [
            key,
            GM_getValue(key, value)
        ])
    );

    const menuOptions = [
        ['showReason', 'Show reason'],
        ['showButton', 'Show button'],
        ['buttonOnlyForNfo', 'Button only for NFO']
    ];

    const menuIds = {};

    function registerMenu() {
        for (const [key, label] of menuOptions) {
            const name = `${settings[key] ? '☑' : '☐'} ${label}`;

            const options = {
                autoClose: false
            };

            if (menuIds[key] != null) {
                options.id = menuIds[key];
            }

            menuIds[key] = GM_registerMenuCommand(
                name,
                () => {
                    settings[key] = !settings[key];
                    GM_setValue(key, settings[key]);

                    registerMenu();
                    updateTrumpReasons();
                },
                options
            );
        }
    }

    // ============================================================
    // Styles
    // ============================================================

    const style = document.createElement('style');
    style.textContent = `
        /* Keep the original table layout stable */
        .torrent-search--list__overview > div:has(> .tm-trump-extra) {
            display: flex !important;
            flex-wrap: wrap;
            align-items: center;
            column-gap: 5px;
            row-gap: 2px;
            min-width: 0;
        }

        .torrent-search--list__overview > div:has(> .tm-trump-extra) > .torrent-search--list__name {
            flex: 0 0 100%;
            min-width: 0;
            max-width: 100%;
            overflow-wrap: anywhere;
        }

        .torrent-search--list__overview > div:has(> .tm-trump-extra) > .torrent-search--list__uploader {
            flex: 0 0 auto !important;
            width: max-content !important;
            max-width: 100%;
            margin: 0 !important;
        }

        .torrent-search--list__overview > div:has(> .tm-trump-extra) > .torrent-icons {
            flex: 0 0 auto !important;
            width: max-content;
            margin: 0 !important;
            white-space: nowrap;
        }

        /* Hide the original skull when moved */
        .torrent-icons > .tm-trump-original {
            display: none !important;
        }

        /* Skull + reason + SRRDB button */
        .tm-trump-extra {
            display: inline-flex;
            flex: 0 0 auto;
            align-items: baseline;
            gap: 6px;
            min-width: 0;
            max-width: 100%;
            margin: 0;
            white-space: normal;
        }

        .tm-trump-skull {
            flex: 0 0 auto;
        }

        .tm-trump-reason {
            flex: 0 1 auto;
            min-width: 0;
            color: lightcoral;
            white-space: normal;
            overflow-wrap: anywhere;
        }

        .tm-srrdb-button {
            display: inline-block;
            flex: 0 0 auto;
            padding: 0;
            border: none;
            background: transparent;
            color: inherit;
            font: inherit;
            cursor: pointer;
            white-space: nowrap;
            vertical-align: baseline;
        }

        .tm-srrdb-button:hover {
            text-decoration: underline;
        }

        /* Torrent detail page */
        .torrent__tags > li > .tm-trump-extra {
            display: inline-flex !important;
            align-items: baseline;
            gap: 6px !important;
            margin-left: 6px;
            vertical-align: baseline;
        }
    `;
    document.head.appendChild(style);

    // ============================================================
    // Release name extraction
    // ============================================================

    function isDetailPage(pathname = location.pathname) {
        return DETAIL_PATH_REGEX.test(pathname);
    }

    function getFolderName(doc) {
        const groups = doc.querySelectorAll('li[x-data="dialog"]');

        for (const group of groups) {
            const fileButton = [...group.querySelectorAll('button')]
                .find(button => button.textContent.includes('Zeige Dateien'));

            if (!fileButton) continue;

            const hierarchy = group.querySelector(
                '[x-bind="tabPanel"][data-tab="hierarchy"]'
            );

            const folderIcon = hierarchy?.querySelector(
                ':scope > span > i.fa-folder'
            );

            const folderName = folderIcon
                ?.nextElementSibling
                ?.textContent
                ?.trim();

            if (folderName) return folderName;
        }

        return null;
    }

    function getMediaInfoName(doc) {
        const section = doc.querySelector('.mediainfo__filename');

        if (!section) return null;

        const clone = section.cloneNode(true);
        clone.querySelector('h3')?.remove();

        const filename = clone.textContent.trim();

        if (!filename) return null;

        return filename.replace(/\.[^.\\/]+$/, '');
    }

    function getReleaseName(doc) {
        return getFolderName(doc) || getMediaInfoName(doc);
    }

    // ============================================================
    // Torrent detail URL lookup
    // ============================================================

    function getDetailUrl(button) {
        const row = button.closest('tr');

        if (!row) return null;

        const links = [
            ...row.querySelectorAll('a.torrent-search--list__name[href]'),
            ...row.querySelectorAll('a[href]')
        ];

        for (const link of links) {
            const url = new URL(link.getAttribute('href'), location.href);

            if (
                url.origin === location.origin &&
                isDetailPage(url.pathname)
            ) {
                return url.href;
            }
        }

        return null;
    }

    function fetchReleaseName(url) {
        if (releaseCache.has(url)) {
            return releaseCache.get(url);
        }

        const promise = fetch(url, {
            credentials: 'same-origin'
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                return response.text();
            })
            .then(html => {
                const doc = new DOMParser().parseFromString(
                    html,
                    'text/html'
                );

                const releaseName = getReleaseName(doc);

                if (!releaseName) {
                    throw new Error(
                        'No folder or MediaInfo filename found.'
                    );
                }

                return releaseName;
            })
            .catch(error => {
                releaseCache.delete(url);
                throw error;
            });

        releaseCache.set(url, promise);

        return promise;
    }

    function getSrrdbUrl(releaseName) {
        return `https://www.srrdb.com/release/details/${encodeURIComponent(releaseName)}`;
    }

    // ============================================================
    // SRRDB button behavior
    // ============================================================

    async function handleSrrdbClick(event) {
        event.preventDefault();

        const button = event.currentTarget;

        if (isDetailPage()) {
            const releaseName = getReleaseName(document);

            if (!releaseName) {
                alert('Could not find a release name.');
                return;
            }

            window.open(
                getSrrdbUrl(releaseName),
                '_blank',
                'noopener'
            );
            return;
        }

        const detailUrl = getDetailUrl(button);

        if (!detailUrl) {
            alert('Could not find the torrent detail URL.');
            return;
        }

        const tab = window.open('about:blank', '_blank');

        if (!tab) {
            alert('Could not open a new tab. Check your popup blocker.');
            return;
        }

        tab.opener = null;
        tab.document.title = 'SRRDB Lookup';
        tab.document.body.textContent = 'Looking up release name...';

        try {
            const releaseName = await fetchReleaseName(detailUrl);

            if (!tab.closed) {
                tab.location.replace(getSrrdbUrl(releaseName));
            }
        } catch (error) {
            console.error('[RHD SRRDB]', error);

            if (!tab.closed) {
                tab.document.body.textContent =
                    `SRRDB lookup failed: ${error.message}`;
            }
        }
    }

    // ============================================================
    // Trump reasons and buttons
    // ============================================================

    function updateTrumpReasons() {
        document.querySelectorAll(
            '.torrent-icons > .torrent-icons__torrent-trump.fa-skull-crossbones'
        ).forEach(icon => {
            const container = icon.closest('.torrent-icons');
            if (!container) return;

            const reason = (icon.getAttribute('title') || '')
                .replace(TRUMP_PREFIX, '')
                .trim();

            // Determine which elements should be shown.
            const displayReason =
                settings.showReason && Boolean(reason);

            const displayButton =
                settings.showButton &&
                (
                    !settings.buttonOnlyForNfo ||
                    NFO_REGEX.test(reason)
                );

            let extra = container.nextElementSibling;

            if (!extra?.classList.contains('tm-trump-extra')) {
                extra = null;
            }

            // Neither reason nor button enabled:
            // restore the original skull icon.
            if (!displayReason && !displayButton) {
                extra?.remove();
                icon.classList.remove('tm-trump-original');
                return;
            }

            // Create the extra container.
            if (!extra) {
                extra = document.createElement('span');
                extra.className = 'tm-trump-extra';

                container.insertAdjacentElement('afterend', extra);
            }

            // Move the skull visually into the extra container.
            let skull = extra.querySelector(':scope > .tm-trump-skull');

            if (!skull) {
                skull = icon.cloneNode(true);
                skull.classList.remove('tm-trump-original');
                skull.classList.add('tm-trump-skull');

                extra.prepend(skull);
            }

            if (skull.title !== icon.title) {
                skull.title = icon.title;
            }

            icon.classList.add('tm-trump-original');

            // ----------------------------------------------------
            // Reason visibility
            // ----------------------------------------------------

            let label = extra.querySelector(':scope > .tm-trump-reason');

            if (displayReason) {
                if (!label) {
                    label = document.createElement('span');
                    label.className = 'tm-trump-reason';

                    skull.insertAdjacentElement('afterend', label);
                }

                if (label.textContent !== reason) {
                    label.textContent = reason;
                }
            } else {
                label?.remove();
            }

            // ----------------------------------------------------
            // SRRDB button visibility
            // ----------------------------------------------------

            let button = extra.querySelector(':scope > .tm-srrdb-button');

            if (displayButton) {
                if (!button) {
                    button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'tm-srrdb-button';
                    button.title = 'Search release on SRRDB';
                    button.setAttribute(
                        'aria-label',
                        'Search release on SRRDB'
                    );
                    button.innerHTML =
                        '<i class="fas fa-search"></i> SRRDB';

                    button.addEventListener(
                        'click',
                        handleSrrdbClick
                    );

                    extra.appendChild(button);
                }
            } else {
                button?.remove();
            }
        });
    }

    // ============================================================
    // Dynamic content observer
    // ============================================================

    let scheduled = false;

    const observer = new MutationObserver(() => {
        if (scheduled) return;

        scheduled = true;

        requestAnimationFrame(() => {
            scheduled = false;
            updateTrumpReasons();
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['title']
    });

    // ============================================================
    // Initialize
    // ============================================================

    registerMenu();
    updateTrumpReasons();

})();