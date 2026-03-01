// ==UserScript==
// @name         デジスマ iPhone最適化（軽量版）
// @namespace    https://github.com/namiki-automation/digikar-iphone
// @version      2.0.0
// @description  デジスマの元のUIを壊さずに、iPhoneでの表示だけを改善する
// @author       NAMIKI_AUTOMATION
// @match        https://console.digikar-smart.jp/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// v2.0.0 方針：「壊さない」
//   - 元のUIの display, flex, レイアウトは一切変更しない
//   - 変えるのは：横スクロール防止、文字サイズ、入力欄のズーム防止だけ
//   - ボタンやリンクの配置は触らない
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

(function () {
    'use strict';

    // ── ログ出力 ──
    var log = function(msg) { console.log('[デジスマ最適化 v2] ' + msg); };

    // ============================================================
    // ■ Viewport 設定
    //   width=device-width にして、元のレスポンシブをそのまま使う
    //   ※ v1 では width=375 に固定していたが、これが崩れの原因だった
    // ============================================================
    function fixViewport() {
        var viewport = document.querySelector('meta[name="viewport"]');
        if (!viewport) {
            viewport = document.createElement('meta');
            viewport.name = 'viewport';
            (document.head || document.documentElement).appendChild(viewport);
        }
        // デバイス幅に合わせる（元のレイアウトを尊重）
        viewport.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
        log('Viewport 設定完了');
    }

    // ============================================================
    // ■ 最小限のCSS修正
    //   【変更するもの】
    //     - 横スクロール防止
    //     - 入力欄のフォントサイズ（iOS自動ズーム防止）
    //     - セーフエリア（ノッチ対応）
    //   【変更しないもの】
    //     - ボタンのサイズ、配置、display
    //     - テーブルの構造
    //     - ナビゲーション、ヘッダー
    //     - その他すべてのレイアウト
    // ============================================================
    var MOBILE_CSS = [
        // 横スクロール防止（これだけで大きく改善）
        'html, body {',
        '  overflow-x: hidden !important;',
        '  max-width: 100vw !important;',
        '  -webkit-text-size-adjust: 100% !important;',
        '}',

        // 入力欄: 16px未満だとiOSが勝手にズームするので16pxにする
        // ※ 見た目は変えず、ズーム防止だけが目的
        'input, select, textarea {',
        '  font-size: 16px !important;',
        '}',

        // セーフエリア（ノッチ対応）
        'body {',
        '  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left) !important;',
        '}',

        // 画像がはみ出ないように（これは安全な変更）
        'img {',
        '  max-width: 100% !important;',
        '  height: auto !important;',
        '}',
    ].join('\n');

    function injectCSS() {
        if (document.getElementById('digikar-iphone-style')) return;
        var style = document.createElement('style');
        style.id = 'digikar-iphone-style';
        style.textContent = MOBILE_CSS;
        document.head.appendChild(style);
        log('CSS 注入完了（軽量版）');
    }

    // ============================================================
    // ■ 初期化
    // ============================================================
    log('軽量版 v2.0 初期化開始');
    fixViewport();
    injectCSS();
    log('完了 - 元のUIを維持しつつ横スクロールとズームを修正');

})();
