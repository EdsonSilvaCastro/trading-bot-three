// ============================================================
// Bybit API v5 Client Wrapper
// ============================================================

import axios, { AxiosInstance } from 'axios';
import { BybitKlineResponse, BybitTickerResponse } from '../types/index.js';

const MAINNET_URL = 'https://api.bybit.com';
const TESTNET_URL = 'https://api-testnet.bybit.com';

/**
 * Thin wrapper around the Bybit v5 REST API.
 * Handles base URL selection (mainnet / testnet) via BYBIT_TESTNET env var.
 */
export class BybitClient {
  private readonly http: AxiosInstance;

  constructor() {
    const isTestnet = process.env['BYBIT_TESTNET'] === 'true';
    const baseURL = isTestnet ? TESTNET_URL : MAINNET_URL;

    this.http = axios.create({
      baseURL,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Get current last price for a symbol from /v5/market/tickers.
   */
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
   * Returns raw list arrays: [startTime, open, high, low, close, volume, turnover]
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
}

export const bybitClient = new BybitClient();
