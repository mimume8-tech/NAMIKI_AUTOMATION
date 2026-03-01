// ==UserScript==
// @name         デジスマ iPhone最適化
// @namespace    https://github.com/namiki-automation/digikar-iphone
// @version      1.0.0
// @description  デジスマ（診療支援システム）をiPhone Safariで快適に使うためのモバイル表示最適化スクリプト
// @author       NAMIKI_AUTOMATION
// @match        https://console.digikar-smart.jp/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 【使い方】
//   iPhone Safari でこのスクリプトを動かすには、
//   App Store から「Userscripts」アプリを入れてください。
//   （Justin Wasack 製、無料）
//   インストール後、このファイルを Userscripts に登録します。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

(function () {
    'use strict';

    // ============================================================
    // ■ デバッグログ用のヘルパー
    //   コンソールに "[デジスマ最適化]" というプレフィックスをつけて出力
    //   iPhone の Safari Web Inspector で確認できます
    // ============================================================
    const log = (msg) => console.log('[デジスマ最適化] ' + msg);

    // ============================================================
    // ■ STEP 1: Viewport（表示領域）をスマホサイズに固定
    //
    //   デジスマはPC向けに作られているため、そのままだと
    //   iPhoneで文字が極小になってしまいます。
    //   width=375 で iPhone SE/8/X と同じ幅に設定します。
    //   user-scalable=no でピンチズームを制限します。
    // ============================================================
    function fixViewport() {
        // 既存の <meta name="viewport"> タグを探す
        let viewport = document.querySelector('meta[name="viewport"]');

        if (!viewport) {
            // なければ新しく作る
            viewport = document.createElement('meta');
            viewport.name = 'viewport';
            // <head> が存在すれば追加、まだなければ <html> に追加
            (document.head || document.documentElement).appendChild(viewport);
        }

        // iPhone の標準的な幅 375px に固定し、自動ズームを防止
        viewport.content = [
            'width=375',
            'initial-scale=1.0',
            'maximum-scale=1.0',
            'user-scalable=no',
            'viewport-fit=cover', // iPhone X以降のノッチに対応
        ].join(', ');

        log('Viewport を 375px に設定しました');
    }

    // ============================================================
    // ■ STEP 2: モバイル最適化CSS を注入
    //
    //   JavaScript で <style> タグを生成し、ページに挿入します。
    //   !important を使って、サイト既存のスタイルに優先します。
    // ============================================================

    // --- CSSを文字列として定義 ---
    const MOBILE_CSS = `

        /* ════════════════════════════════
           基本レイアウト：横スクロール排除
           ════════════════════════════════ */
        html, body {
            /* 横方向のはみ出しを隠す → 横スクロールが消える */
            overflow-x: hidden !important;
            max-width: 100vw !important;
            /* タップ時に出る青い枠（ハイライト）を非表示にする */
            -webkit-tap-highlight-color: transparent !important;
            /* iOSでのスクロールをスムーズに */
            -webkit-overflow-scrolling: touch !important;
        }

        /* ════════════════════════════════
           フォントサイズ最適化
           iOSは入力欄が 16px 未満だと自動でズームする仕様。
           それを防ぐために 16px 以上に設定する。
           ════════════════════════════════ */
        body {
            font-size: 16px !important;
            line-height: 1.6 !important;
        }

        /* 入力欄・セレクトボックス・テキストエリア */
        input,
        select,
        textarea {
            font-size: 16px !important;
            /* iOSの独自スタイル（丸みなど）をリセット */
            -webkit-appearance: none !important;
            border-radius: 6px !important;
            padding: 10px !important;
            box-sizing: border-box !important;
            width: 100% !important;
        }

        /* ════════════════════════════════
           タップエリア最小 44×44px
           Apple のヒューマンインターフェイスガイドライン準拠。
           小さいボタンは指で押しにくいため、最小サイズを保証する。
           ════════════════════════════════ */
        button,
        a,
        input[type="button"],
        input[type="submit"],
        input[type="reset"],
        [role="button"],
        .btn,
        .button,
        .clickable {
            min-height: 44px !important;
            min-width: 44px !important;
            padding: 10px 16px !important;
            font-size: 16px !important;
            font-weight: bold !important;
            border-radius: 8px !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            cursor: pointer !important;
            /* 文字や要素が溢れないよう */
            box-sizing: border-box !important;
        }

        /* ════════════════════════════════
           患者ID：青太字で目立たせる
           ※ デジスマの実際のクラス名に合わせて調整が必要
           ════════════════════════════════ */
        [class*="patient-id"],
        [class*="patientId"],
        [class*="patient_id"],
        [class*="kanja-id"],
        [class*="kanjaId"],
        [data-field="id"],
        [data-field="patient_id"],
        td.id,
        td:first-child {  /* テーブル1列目（患者IDが多い） */
            font-size: 18px !important;
            font-weight: bold !important;
            color: #1a73e8 !important;   /* Googleブルー：視認性が高い */
            letter-spacing: 0.05em !important;
        }

        /* ════════════════════════════════
           患者氏名：大きく・濃く表示
           ※ デジスマの実際のクラス名に合わせて調整が必要
           ════════════════════════════════ */
        [class*="patient-name"],
        [class*="patientName"],
        [class*="patient_name"],
        [class*="kanja-name"],
        [class*="kanjaName"],
        [data-field="name"],
        [data-field="patient_name"],
        td.name {
            font-size: 20px !important;
            font-weight: bold !important;
            color: #202124 !important;   /* ほぼ黒：最も読みやすい */
        }

        /* ════════════════════════════════
           テーブル（患者一覧など）のモバイル対応
           PC向けの横長テーブルを画面内に収める
           ════════════════════════════════ */
        table {
            display: block !important;
            /* テーブル内は横スクロール可（データが多い場合）*/
            overflow-x: auto !important;
            width: 100% !important;
            max-width: 100vw !important;
            border-collapse: collapse !important;
        }

        /* テーブルの各行：タップしやすい高さを確保 */
        tr {
            min-height: 44px !important;
        }

        /* テーブルのセル */
        td, th {
            padding: 10px 8px !important;
            font-size: 14px !important;
            vertical-align: middle !important;
            word-break: break-word !important; /* 長い文字列を折り返す */
        }

        /* ヘッダー行 */
        th {
            background-color: #f1f3f4 !important;
            font-weight: bold !important;
            position: sticky !important;
            top: 0 !important;
            z-index: 10 !important;
        }

        /* ════════════════════════════════
           ヘッダー・ナビ：画面上部に固定
           スクロールしてもヘッダーが見えるように
           ════════════════════════════════ */
        nav,
        header,
        .navbar,
        .header,
        [class*="header"],
        [class*="navbar"] {
            position: sticky !important;
            top: 0 !important;
            z-index: 9999 !important;
            width: 100% !important;
            max-width: 100vw !important;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1) !important;
        }

        /* ════════════════════════════════
           コンテナ・ラッパー：幅を画面内に収める
           PC向けの固定幅（例：1200px）を上書きして
           iPhone画面に収まるようにする
           ════════════════════════════════ */
        .container,
        .wrapper,
        .content,
        .main,
        main,
        [class*="layout"],
        [class*="container"],
        [class*="wrapper"] {
            max-width: 100% !important;
            width: 100% !important;
            padding-left: 8px !important;
            padding-right: 8px !important;
            box-sizing: border-box !important;
            overflow-x: hidden !important;
        }

        /* ════════════════════════════════
           モーダル・ダイアログ：画面内に収める
           PC向けの大きなモーダルをiPhone用に調整
           ════════════════════════════════ */
        [role="dialog"],
        .modal,
        .modal-dialog,
        .dialog,
        [class*="modal"],
        [class*="dialog"] {
            max-width: 100vw !important;
            max-height: 85vh !important;
            overflow-y: auto !important;
            margin: 0 auto !important;
            border-radius: 12px 12px 0 0 !important; /* 下から出るシートっぽく */
        }

        /* ════════════════════════════════
           フォームのラベル
           ════════════════════════════════ */
        label {
            font-size: 14px !important;
            font-weight: bold !important;
            color: #5f6368 !important;
            display: block !important;
            margin-bottom: 4px !important;
        }

        /* ════════════════════════════════
           画像がはみ出ないように
           ════════════════════════════════ */
        img {
            max-width: 100% !important;
            height: auto !important;
        }

        /* ════════════════════════════════
           診療ボタン（主要操作ボタン）を特に大きく
           デジスマの主要な操作ボタンに特化したスタイル
           ※ 実際のクラス名に合わせて調整してください
           ════════════════════════════════ */
        .primary-action,
        .main-action,
        [class*="primary"],
        button[class*="primary"],
        .btn-primary,
        button[type="submit"] {
            min-height: 52px !important;      /* 通常より大きめ */
            font-size: 18px !important;
            background-color: #1a73e8 !important;
            color: white !important;
            border: none !important;
            border-radius: 10px !important;
            width: 100% !important;
            margin: 6px 0 !important;
            box-shadow: 0 2px 6px rgba(26,115,232,0.4) !important;
        }

        /* 危険・削除系のボタン（赤） */
        .btn-danger,
        button[class*="danger"],
        button[class*="delete"],
        [class*="cancel-btn"] {
            min-height: 44px !important;
            font-size: 16px !important;
            background-color: #d93025 !important;
            color: white !important;
            border: none !important;
            border-radius: 8px !important;
        }

        /* ════════════════════════════════
           セーフエリア（iPhone X以降のノッチ対応）
           コンテンツがノッチや底のバーに被らないように余白を確保
           ════════════════════════════════ */
        body {
            padding-top: env(safe-area-inset-top) !important;
            padding-bottom: env(safe-area-inset-bottom) !important;
            padding-left: env(safe-area-inset-left) !important;
            padding-right: env(safe-area-inset-right) !important;
        }
    `;

    // --- <style> タグを生成してページに注入 ---
    function injectCSS() {
        // 重複注入を防ぐ：同じIDのスタイルがすでにあれば何もしない
        if (document.getElementById('digikar-iphone-style')) return;

        const style = document.createElement('style');
        style.id = 'digikar-iphone-style';
        style.textContent = MOBILE_CSS;

        // <head> が存在すれば追加、なければ <html> に追加
        (document.head || document.documentElement).appendChild(style);

        log('CSS を注入しました');
    }

    // ============================================================
    // ■ STEP 3: 患者情報の視認性を JavaScript でさらに強化
    //
    //   CSSだけでは届かないケース（インラインスタイルの上書きなど）に
    //   JavaScriptで直接スタイルを適用します。
    //   デジスマのDOM構造が判明したら、セレクタを実際のものに変更してください。
    // ============================================================
    function enhancePatientInfo() {
        // ── 患者ID の強調 ──────────────────────────────────────
        // よく使われるクラス名パターンを列挙（実際のクラス名に要調整）
        const idSelectors = [
            '[class*="patient-id"]',
            '[class*="patientId"]',
            '[class*="patient_id"]',
            '[class*="kanja-id"]',
            '[data-field="id"]',
            '[data-field="patient_id"]',
        ];

        idSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                el.style.fontWeight = 'bold';
                el.style.fontSize = '18px';
                el.style.color = '#1a73e8';  // 青
                el.style.letterSpacing = '0.05em';
            });
        });

        // ── 患者氏名 の強調 ────────────────────────────────────
        const nameSelectors = [
            '[class*="patient-name"]',
            '[class*="patientName"]',
            '[class*="patient_name"]',
            '[class*="kanja-name"]',
            '[data-field="name"]',
            '[data-field="patient_name"]',
        ];

        nameSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                el.style.fontWeight = 'bold';
                el.style.fontSize = '20px';
                el.style.color = '#202124';  // ほぼ黒
            });
        });
    }

    // ============================================================
    // ■ STEP 4: ボタンのタップエリアを JavaScript でも保証
    //
    //   CSSだけでは対応できないケース（インラインスタイルなど）を
    //   JavaScriptで補完します。
    // ============================================================
    function enhanceButtons() {
        // クリック可能な要素をすべて取得
        const tapTargets = document.querySelectorAll(
            'button, [role="button"], a.btn, a.button, .clickable, input[type="submit"], input[type="button"]'
        );

        tapTargets.forEach(el => {
            const rect = el.getBoundingClientRect();

            // タップエリアが44px未満の場合のみ修正（余分な変更を避ける）
            if (rect.height < 44) {
                el.style.minHeight = '44px';
                el.style.display = 'inline-flex';
                el.style.alignItems = 'center';
                el.style.justifyContent = 'center';
            }
            if (rect.width > 0 && rect.width < 44) {
                el.style.minWidth = '44px';
            }
        });
    }

    // ============================================================
    // ■ STEP 5: コンテナの幅をモバイルに合わせる
    // ============================================================
    function fixLayout() {
        // body の横はみ出し防止
        document.body.style.maxWidth = '100vw';
        document.body.style.overflowX = 'hidden';

        // よくある PC 向け固定幅コンテナを上書き
        const containers = document.querySelectorAll(
            '.container, .wrapper, main, [class*="layout"]'
        );
        containers.forEach(el => {
            el.style.maxWidth = '100%';
            el.style.width = '100%';
            el.style.overflowX = 'hidden';
        });

        log('レイアウトを修正しました');
    }

    // ============================================================
    // ■ STEP 6: MutationObserver でページの動的変化に追従
    //
    //   デジスマは React 等の SPA（シングルページアプリ）の可能性があり、
    //   画面遷移のたびにDOMが書き換えられます。
    //   MutationObserver を使って変化を監視し、その都度最適化を再適用します。
    // ============================================================
    function startObserver() {
        let debounceTimer = null;

        const observer = new MutationObserver(function (mutations) {
            // DOM 変化のたびにタイマーをリセット（連続変化をまとめて処理）
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(function () {
                // 動的に追加された要素にも最適化を適用
                enhancePatientInfo();
                enhanceButtons();
            }, 250); // 250ms 後にまとめて実行（パフォーマンス考慮）
        });

        // <body> 以下の全要素の追加・削除を監視
        observer.observe(document.body, {
            childList: true,  // 直接の子要素の追加・削除を監視
            subtree: true,    // すべての子孫要素も対象にする
        });

        log('MutationObserver を開始しました（動的コンテンツ対応）');
        return observer;
    }

    // ============================================================
    // ■ 初期化：各ステップを正しい順序で実行
    // ============================================================

    // --- document-start で即実行（DOM読み込み前） ---
    // CSS と Viewport はページ表示の最初に設定することが重要
    log('初期化開始 (document-start)');
    fixViewport(); // Viewport を最初に設定
    injectCSS();   // CSS を最初に注入

    // --- DOM が読み込まれてから実行 ---
    // JS で DOM を操作する処理は DOM の準備が必要
    function onDOMReady() {
        log('DOM 読み込み完了、モバイル最適化を実行中...');

        fixLayout();          // コンテナ幅の修正
        enhancePatientInfo(); // 患者情報の強調
        enhanceButtons();     // ボタンのタップエリア確保
        startObserver();      // 動的コンテンツの監視開始

        log('すべての最適化が完了しました');
    }

    // DOM の読み込み状態に応じて実行タイミングを調整
    if (document.readyState === 'loading') {
        // まだ読み込み中なら、完了イベントを待つ
        document.addEventListener('DOMContentLoaded', onDOMReady);
    } else {
        // すでに DOM が読み込まれていれば即時実行
        onDOMReady();
    }

})(); // 即時実行関数 (IIFE) で変数のグローバル汚染を防ぐ
