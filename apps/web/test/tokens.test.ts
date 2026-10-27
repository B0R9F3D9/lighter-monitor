import { describe, expect, it } from "bun:test";
import { getTokenImageUrl, registerTokenLogos, registerTokens } from "../src/shared/tokens";

describe("Token Logos & Image URL Resolution", () => {
  it("resolves clean base token logo and does not clobber it with /USDG spot pair logo", () => {
    // Simulate real Robinhood Lighter API /tokenlist payload
    registerTokens([
      {
        symbol: "QQQ",
        name: "Invesco QQQ Trust Series I",
        logo: "qqq",
        logo_extension: "png",
        market: "PERPS",
      },
      {
        symbol: "QQQ/USDG",
        name: "Invesco QQQ Trust Series I",
        logo: "qqqUsdg",
        logo_extension: "png",
        market: "SPOT",
      },
      {
        symbol: "SPY",
        name: "SPDR S&P 500 ETF Trust",
        logo: "spy",
        logo_extension: "png",
        market: "PERPS",
      },
      {
        symbol: "SPY/USDG",
        name: "SPDR S&P 500 ETF Trust",
        logo: "spyUsdg",
        logo_extension: "png",
        market: "SPOT",
      },
    ]);

    // Base tokens must have clean single token logo, NOT qqqUsdg.png or spyUsdg.png
    expect(getTokenImageUrl("QQQ")).toBe("https://assets.lighter.xyz/fe/token/qqq.png");
    expect(getTokenImageUrl("SPY")).toBe("https://assets.lighter.xyz/fe/token/spy.png");

    // Explicit trading pair queries retain composite spot logo
    expect(getTokenImageUrl("QQQ/USDG")).toBe("https://assets.lighter.xyz/fe/token/qqqUsdg.png");
    expect(getTokenImageUrl("SPY/USDG")).toBe("https://assets.lighter.xyz/fe/token/spyUsdg.png");
  });

  it("handles spot pair coming before base token in tokenlist without clobbering", () => {
    registerTokenLogos([
      {
        symbol: "AMD/USDG",
        logo: "amdUsdg",
        logo_extension: "png",
      },
      {
        symbol: "AMD",
        logo: "amd",
        logo_extension: "png",
      },
    ]);

    expect(getTokenImageUrl("AMD")).toBe("https://assets.lighter.xyz/fe/token/amd.png");
  });

  it("cleans composite Usdg/Usdc suffix even if token only exists in spot pair", () => {
    registerTokenLogos([
      {
        symbol: "XYZ/USDG",
        logo: "xyzUsdg",
        logo_extension: "png",
      },
    ]);

    expect(getTokenImageUrl("XYZ")).toBe("https://assets.lighter.xyz/fe/token/xyz.png");
    expect(getTokenImageUrl("XYZ/USDG")).toBe("https://assets.lighter.xyz/fe/token/xyzUsdg.png");
  });

  it("falls back to lowercase symbol if token not in tokenlist", () => {
    expect(getTokenImageUrl("UNKNOWNCOIN")).toBe(
      "https://assets.lighter.xyz/fe/token/unknowncoin.png",
    );
  });
});
