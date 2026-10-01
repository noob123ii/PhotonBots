'use strict';

const blessed = require('blessed');

const SYM = {
    idle: '[ ]',
    steam: '[~]',
    auth: '[*]',
    join: '[>]',
    done: '[+]',
    fail: '[-]',
    ok: '[/]'
};

function createUI(accounts) {
    const screen = blessed.screen({
        smartCSR: true,
        title: 'Gorilla Tag Lobby Joiner',
        dockBorders: true,
        fullUnicode: true,
        terminal: 'xterm-256color',
        forceUnicode: true
    });

    // Title bar
    const title = blessed.box({
        top: 0, left: 0, width: '100%', height: 3,
        content: ' {bold}GORILLA TAG LOBBY JOINER{/bold} ',
        tags: true,
        fg: 'white', bg: 'black',
        border: { type: 'line', fg: 'white' },
        style: { fg: 'white', bg: 'black', bold: true },
        padding: { top: 0, bottom: 0 }
    });
    screen.append(title);

    // Account list panel (left side)
    const accountBox = blessed.box({
        top: 3, left: 0, width: '34%', height: '70%',
        label: ' Accounts ',
        border: { type: 'line', fg: 'white' },
        fg: 'white', bg: 'black',
        style: { fg: 'white', bg: 'black' },
        scrollable: true,
        scrollbar: { ch: ' ', fg: 'white', bg: 'white' },
        alwaysScroll: true,
        keys: true,
        vi: true
    });
    screen.append(accountBox);

    const accountList = blessed.list({
        parent: accountBox,
        top: 0, left: 1, width: '100%-2', height: '100%-1',
        fg: 'white', bg: 'black',
        selectedFg: 'black', selectedBg: 'white',
        style: { fg: 'white', bg: 'black', selected: { fg: 'black', bg: 'white' } },
        items: accounts.map((a, i) => `${SYM.idle} ${i + 1}. ${a.nickname || a.username}`),
        keys: false,
        vi: false
    });
    accountBox.setContent('');

    // Log panel (right side)
    const logBox = blessed.box({
        top: 3, left: '34%', width: '66%', height: '70%',
        label: ' Log ',
        border: { type: 'line', fg: 'white' },
        fg: 'white', bg: 'black',
        style: { fg: 'white', bg: 'black' },
        scrollable: true,
        scrollbar: { ch: ' ', fg: 'white', bg: 'white' },
        alwaysScroll: true,
        tags: true,
        keys: true,
        vi: true
    });
    screen.append(logBox);

    // Inputs panel (bottom area)
    const inputBox = blessed.box({
        top: '70%+3', left: 0, width: '100%', height: '20%',
        label: ' Controls ',
        border: { type: 'line', fg: 'white' },
        fg: 'white', bg: 'black',
        style: { fg: 'white', bg: 'black' }
    });
    screen.append(inputBox);

    // Text inputs within the input box
    const formLabels = [
        { key: 'room', label: 'Room code:', default: '' },
        { key: 'region', label: 'Region:', default: 'usw' },
        { key: 'count', label: 'Count:', default: String(Math.min(accounts.length, 3)) },
        { key: 'follow', label: 'Follow (blank=none):', default: '' }
    ];

    let currentInput = 0;
    const inputs = [];

    formLabels.forEach((fl, i) => {
        const row = blessed.box({
            parent: inputBox,
            top: i * 2, left: 1, width: '100%-2', height: 2,
            fg: 'white', bg: 'black',
            content: ` {bold}${fl.label}{/bold} `
        });
        const input = blessed.textbox({
            parent: row,
            top: 0, left: fl.label.length + 3, width: 30, height: 1,
            fg: 'white', bg: 'black',
            border: { type: 'line', fg: 'white' },
            style: { fg: 'white', bg: 'black', border: { fg: 'white' } },
            inputOnFocus: true,
            value: fl.default
        });
        inputs.push(input);
        row.setContent('');
    });

    // Start button
    const startBtn = blessed.button({
        parent: inputBox,
        bottom: 1, left: 1, width: 12, height: 1,
        content: ' {bold}START{/bold} ',
        tags: true,
        fg: 'white', bg: 'black',
        border: { type: 'line', fg: 'white' },
        style: { fg: 'white', bg: 'black', focus: { fg: 'black', bg: 'white' } },
        mouse: true
    });
    screen.append(startBtn);

    // Status bar at bottom
    const statusBar = blessed.box({
        bottom: 0, left: 0, width: '100%', height: 1,
        fg: 'white', bg: 'black',
        content: ' Ready | 0/0 joined | 0 failed',
        style: { fg: 'white', bg: 'black' }
    });
    screen.append(statusBar);

    // ─── Helpers ───

    function getValues() {
        return {
            room: inputs[0].getValue().trim().toUpperCase(),
            region: inputs[1].getValue().trim(),
            count: parseInt(inputs[2].getValue().trim()) || accounts.length,
            follow: inputs[3].getValue().trim()
        };
    }

    const logLines = [];

    function log(msg) {
        const ts = new Date().toISOString().slice(11, 19);
        logLines.push(ts + ' ' + msg);
        if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
        logBox.setContent(logLines.join('\n'));
        logBox.setScrollPerc(100);
        screen.render();
    }

    function setAccountStatus(idx, status) {
        const a = accounts[idx];
        if (!a) return;
        const sym = SYM[status] || SYM.idle;
        const name = a.nickname || a.username;
        accountList.setItem(idx, `${sym} ${idx + 1}. ${name}`);
        screen.render();
    }

    function setStatusText(text) {
        statusBar.setContent(' ' + text);
        screen.render();
    }

    function setAllIdle() {
        accounts.forEach((a, i) => accountList.setItem(i, `${SYM.idle} ${i + 1}. ${a.nickname || a.username}`));
        screen.render();
    }

    function updateStats(joined, failed, room) {
        const total = accounts.length;
        setStatusText(`Joined: ${joined}/${total} | Failed: ${failed} | Room: ${room || '?'}`);
    }

    return {
        screen,
        inputs,
        startBtn,
        accountList,
        logBox,
        log,
        setAccountStatus,
        setStatusText,
        setAllIdle,
        updateStats,
        getValues,
        currentInput,
        destroy: () => { try { screen.destroy(); } catch {} }
    };
}

module.exports = { createUI };
