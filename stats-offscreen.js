// DOM parsing isolated from the MV3 service worker. Offscreen page cannot
// navigate users, and accepts messages only from the extension's background.
(() => {
  'use strict';
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['kinoStatsParseProfilePage','kinoWatchlistParsePage'].includes(message?.action)) return;
    if (sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL('background.js')) {
      // Service workers can be represented with sender.url undefined;
      // reject known non-background pages and content scripts.
      const backgroundUrl=chrome.runtime.getURL('background.js');
      if (sender.id !== chrome.runtime.id ||
          (sender.url && sender.url !== backgroundUrl) ||
          sender.tab) {
        respond({ok:false,error:'untrusted sender'});
        return false;
      }
    }
    try {
      const {html,page}=message;
      if (typeof html !== 'string' || html.length > 9e6 ||
          !Number.isSafeInteger(page) || page<1) {
        respond({ok:false,error:'bad profile document'});
        return false;
      }
      const result=message.action==='kinoWatchlistParsePage'
        ? window.KinoPlannedParser.parsePage(html,page)
        : window.KinoProfileVotes.parsePage(html,page);
      respond({ok:true,result});
    } catch(error) {
      respond({ok:false,error:String(error?.message||error).slice(0,200)});
    }
    return false;
  });
})();
