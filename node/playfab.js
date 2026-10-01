'use strict';

// PlayFab Client API for title 63FDD (Gorilla Tag prod).
// LoginWithSteam mirrors PlayFabAuthenticator.AuthenticateWithPlayFab().

async function playfabPost(titleId, api, body, sessionTicket) {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionTicket) headers['X-Authorization'] = sessionTicket;

  const res = await fetch(`https://${titleId}.playfabapi.com/Client/${api}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.code !== 200) {
    const err = new Error(`PlayFab ${api} failed: ${json.errorMessage || res.status} (${json.error || 'unknown'})`);
    err.playfabError = json.error;
    err.playfabErrorMessage = json.errorMessage;
    throw err;
  }
  return json.data;
}

async function loginWithSteam(titleId, steamTicketHex) {
  const data = await playfabPost(titleId, 'LoginWithSteam', {
    TitleId: titleId,
    SteamTicket: steamTicketHex,
    CreateAccount: true
  });
  return {
    sessionTicket: data.SessionTicket,
    playFabId: data.PlayFabId,
    newlyCreated: !!data.NewlyCreated
  };
}

// The game itself reads ANY player's inventory this way
// (PlayerCosmeticsSystem: SharedGroupId = player.UserId + "Inventory").
async function getPlayerInventory(titleId, sessionTicket, playFabId) {
  const data = await playfabPost(titleId, 'GetSharedGroupData', {
    SharedGroupId: `${playFabId}Inventory`,
    Keys: ['InventoryDict']
  }, sessionTicket);

  const record = data.Data && data.Data.InventoryDict;
  if (!record || typeof record.Value !== 'string') return null;
  if (record.Value === 'BANNED') return { banned: true, items: {} };

  try {
    const dict = JSON.parse(record.Value); // Dictionary<string, ItemInstance>
    return { banned: false, items: dict || {} };
  } catch {
    return null;
  }
}

module.exports = { playfabPost, loginWithSteam, getPlayerInventory };
