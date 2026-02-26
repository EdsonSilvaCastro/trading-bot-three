// ============================================================
// Bybit API v5 Client Wrapper - Phase 3
// ============================================================
// Supports public market data + authenticated private endpoints.
// Set BYBIT_TESTNET=true to route to testnet.
// PAPER_TRADING=true blocks all order placement endpoints.
// ============================================================

import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { BybitKlineResponse, BybitTickerResponse } from '../types/index.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('BybitClient');
const MAINNET_URL = 'https://api.bybit.com';
const TESTNET_URL = 'https://api-testnet.bybit.com';

/**
 * Generate Bybit v5 API HMAC-SHA256 signature.
 * preSign = timestamp + apiKey + recvWindow + params
 */
function generateSignature(
  apiSecret: string,
  timestamp: string,
  apiKey: string,
  recvWindow: string,
  params: string,
): string {
  const preSign = timestamp + apiKey + recvWindow + params;
  return crypto.createHmac('sha256', apiSecret).update(preSign).digest('hex');
}

/**
 * Thin wrapper around the Bybit v5 REST API.
 * Handles base URL selection (mainnet / testnet) and auth headers.
 */
export class BybitClient {
  private readonly http: AxiosInstance;

  constructor() {
    const isTestnet = process.env['BYBIT_TESTNET'] === 'true';
    const baseURL = isTestnet ? TESTNET_URL : MAINNET_URL;
    log.info(`BybitClient initialised — ${isTestnet ? 'TESTNET' : 'MAINNET'}`);

    this.http = axios.create({
      baseURL,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // --------------- Auth Helpers ---------------

  private getAuthHeaders(params: string): Record<string, string> {
    const apiKey = process.env['BYBIT_API_KEY'] ?? '';
    const apiSecret = process.env['BYBIT_API_SECRET'] ?? '';
    const timestamp = Date.now().toString();
    const recvWindow = '5000';
    const sign = generateSignature(apiSecret, timestamp, apiKey, recvWindow, params);

    return {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': sign,
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'Content-Type': 'application/json',
    };
  }

  // --------------- Public Endpoints ---------------

  /** Get current last price for a symbol from /v5/market/tickers. */
  async getCurrentPrice(symbol: string): Promise<number> {
    const response = await this.http.get<BybitTickerResponse>('/v5/market/tickers', {
      params: { category: 'linear', symbol },
    });
    const ticker = response.data.result.list[0];
    if (!ticker) throw new Error(`No ticker found for ${symbol}`);
    return parseFloat(ticker.lastPrice);
  }

  /**
   * Fetch klines (OHLCV) from /v5/market/kline.
   * Returns raw arrays: [startTime, open, high, low, close, volume, turnover]
   */
  async getKlines(symbol: string, interval: string, limit: number): Promise<string[][]> {
    const response = await this.http.get<BybitKlineResponse>('/v5/market/kline', {
      params: { category: 'linear', symbol, interval, limit },
    });
    if (response.data.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.data.retMsg}`);
    }
    return response.data.result.list;
  }

  // --------------- Authenticated Endpoints ---------------

  /**
   * Get wallet balance for Unified Trading Account.
   * Returns totalEquity and availableBalance in USDT.
   */
  async getWalletBalance(): Promise<{ totalEquity: number; availableBalance: number }> {
    const params = 'accountType=UNIFIED&coin=USDT';
    const headers = this.getAuthHeaders(params);

    const response = await this.http.get('/v5/account/wallet-balance', {
      params: { accountType: 'UNIFIED', coin: 'USDT' },
      headers,
    });

    if (response.data.retCode !== 0) {
      throw new Error(`getWalletBalance failed: ${response.data.retMsg}`);
    }

    const account = response.data.result?.list?.[0];
    const coin = (account?.coin as Record<string, string>[] | undefined)?.find((c) => c['coin'] === 'USDT');

    return {
      totalEquity: parseFloat(account?.totalEquity ?? '0'),
      availableBalance: parseFloat(
        (coin?.['availableToWithdraw'] as string | undefined) ??
        (coin?.['walletBalance'] as string | undefined) ?? '0'
      ),
    };
  }

  /**
   * Get current open position for a symbol (linear perpetual).
   * Returns null if no position is open.
   */
  async getPosition(symbol: string): Promise<{
    symbol: string;
    side: 'Buy' | 'Sell' | 'None';
    size: string;
    entryPrice: string;
    unrealisedPnl: string;
    leverage: string;
  } | null> {
    const qs = `category=linear&symbol=${symbol}`;
    const headers = this.getAuthHeaders(qs);

    const response = await this.http.get('/v5/position/list', {
      params: { category: 'linear', symbol },
      headers,
    });

    if (response.data.retCode !== 0) {
      throw new Error(`getPosition failed: ${response.data.retMsg}`);
    }

    const pos = response.data.result?.list?.[0];
    if (!pos || pos.side === 'None' || parseFloat(pos.size as string) === 0) return null;

    return {
      symbol: pos.symbol as string,
      side: pos.side as 'Buy' | 'Sell' | 'None',
      size: pos.size as string,
      entryPrice: (pos.avgPrice ?? pos.entryPrice) as string,
      unrealisedPnl: pos.unrealisedPnl as string,
      leverage: pos.leverage as string,
    };
  }

  /**
   * Set leverage for a symbol before placing orders.
   */
  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    const body = JSON.stringify({
      category: 'linear',
      symbol,
      buyLeverage: String(leverage),
      sellLeverage: String(leverage),
    });
    const headers = this.getAuthHeaders(body);
    const response = await this.http.post('/v5/position/set-leverage', body, { headers });

    // 110043 = leverage not modified (already at that level) — treat as success
    if (response.data.retCode !== 0 && response.data.retCode !== 110043) {
      log.warn(`setLeverage: ${response.data.retMsg}`);
      return false;
    }
    return true;
  }

  /**
   * Place a limit order with optional SL/TP.
   * BLOCKED in PAPER_TRADING mode.
   */
  async placeLimitOrder(params: {
    symbol: string;
    side: 'Buy' | 'Sell';
    qty: string;
    price: string;
    stopLoss?: string;
    takeProfit?: string;
    timeInForce?: 'GTC' | 'IOC' | 'FOK';
  }): Promise<{ orderId: string; orderLinkId: string } | null> {
    if (process.env['PAPER_TRADING'] === 'true') {
      log.warn('placeLimitOrder called in PAPER_TRADING mode — order NOT placed');
      return null;
    }

    const body = JSON.stringify({
      category: 'linear',
      symbol: params.symbol,
      side: params.side,
      orderType: 'Limit',
      qty: params.qty,
      price: params.price,
      timeInForce: params.timeInForce ?? 'GTC',
      ...(params.stopLoss && { stopLoss: params.stopLoss }),
      ...(params.takeProfit && { takeProfit: params.takeProfit }),
    });
    const headers = this.getAuthHeaders(body);
    const response = await this.http.post('/v5/order/create', body, { headers });

    if (response.data.retCode !== 0) {
      log.error(`placeLimitOrder failed: ${response.data.retMsg}`);
      return null;
    }
    return { orderId: response.data.result.orderId, orderLinkId: response.data.result.orderLinkId };
  }

  /**
   * Place a market order with optional SL/TP.
   * BLOCKED in PAPER_TRADING mode.
   */
  async placeMarketOrder(params: {
    symbol: string;
    side: 'Buy' | 'Sell';
    qty: string;
    stopLoss?: string;
    takeProfit?: string;
  }): Promise<{ orderId: string; orderLinkId: string } | null> {
    if (process.env['PAPER_TRADING'] === 'true') {
      log.warn('placeMarketOrder called in PAPER_TRADING mode — order NOT placed');
      return null;
    }

    const body = JSON.stringify({
      category: 'linear',
      symbol: params.symbol,
      side: params.side,
      orderType: 'Market',
      qty: params.qty,
      ...(params.stopLoss && { stopLoss: params.stopLoss }),
      ...(params.takeProfit && { takeProfit: params.takeProfit }),
    });
    const headers = this.getAuthHeaders(body);
    const response = await this.http.post('/v5/order/create', body, { headers });

    if (response.data.retCode !== 0) {
      log.error(`placeMarketOrder failed: ${response.data.retMsg}`);
      return null;
    }
    return { orderId: response.data.result.orderId, orderLinkId: response.data.result.orderLinkId };
  }

  /**
   * Cancel an open order by orderId.
   * No-ops gracefully in PAPER_TRADING mode.
   */
  async cancelOrder(symbol: string, orderId: string): Promise<boolean> {
    if (process.env['PAPER_TRADING'] === 'true') return true;

    const body = JSON.stringify({ category: 'linear', symbol, orderId });
    const headers = this.getAuthHeaders(body);
    const response = await this.http.post('/v5/order/cancel', body, { headers });

    if (response.data.retCode !== 0) {
      log.warn(`cancelOrder failed: ${response.data.retMsg}`);
      return false;
    }
    return true;
  }

  /**
   * Get all open (unfilled) orders for a symbol.
   */
  async getOpenOrders(symbol: string): Promise<Array<{
    orderId: string;
    side: string;
    price: string;
    qty: string;
    orderStatus: string;
  }>> {
    const qs = `category=linear&symbol=${symbol}`;
    const headers = this.getAuthHeaders(qs);
    const response = await this.http.get('/v5/order/realtime', {
      params: { category: 'linear', symbol },
      headers,
    });

    if (response.data.retCode !== 0) {
      log.warn(`getOpenOrders failed: ${response.data.retMsg}`);
      return [];
    }
    return (response.data.result?.list ?? []) as Array<{
      orderId: string; side: string; price: string; qty: string; orderStatus: string;
    }>;
  }

  /**
   * Modify the stop loss of an existing position.
   * No-ops gracefully in PAPER_TRADING mode.
   */
  async modifyPositionSL(symbol: string, stopLoss: string): Promise<boolean> {
    if (process.env['PAPER_TRADING'] === 'true') return true;

    const body = JSON.stringify({
      category: 'linear',
      symbol,
      stopLoss,
      slTriggerBy: 'MarkPrice',
    });
    const headers = this.getAuthHeaders(body);
    const response = await this.http.post('/v5/position/trading-stop', body, { headers });

    if (response.data.retCode !== 0) {
      log.warn(`modifyPositionSL failed: ${response.data.retMsg}`);
      return false;
    }
    return true;
  }
}

export const bybitClient = new BybitClient();
