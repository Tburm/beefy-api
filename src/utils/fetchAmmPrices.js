const BigNumber = require('bignumber.js');
const { ethers } = require('ethers');

const MulticallAbi = require('../abis/BeefyPriceMulticall.json');

const MULTICALLS = {
  56: "0x0943afe23cb43BD15aC2d58bACa34Eb570BFC278"
  // TODO: multichain addresses
}

const RPC = {
  56: 'https://bsc-dataseed.binance.org',
  // TODO: multichain rpc
}

const calcTokenPrice = (knownPrice, knownToken, unknownToken) => {
  return knownToken.normalizedBalance.multipliedBy(knownPrice).dividedBy(unknownToken.normalizedBalance).toNumber();
}

const calcLpPrice = (pool, tokenPrices) => {
  const lp0 = pool.lp0.balance.multipliedBy(tokenPrices[pool.lp0.oracleId]).dividedBy(pool.lp0.decimals);
  const lp1 = pool.lp1.balance.multipliedBy(tokenPrices[pool.lp1.oracleId]).dividedBy(pool.lp1.decimals);
  return lp0.plus(lp1).multipliedBy(pool.decimals).dividedBy(pool.totalSupply).toNumber();
}

const fetchAmmPrices = async (pools, tokenPrices) => {
  let poolPrices = {};

  // TODO: extract to fetchChainPrices
  for (let chain in MULTICALLS) {
    let filtered = pools.filter(p => p.chainId === chain);
    
    // Old BSC pools don't have the chainId attr
    if (chain === "56"){
      filtered = filtered.concat(pools.filter(p => p.chainId === undefined));
    }
    
    // Setup multichain 
    const provider = new ethers.providers.JsonRpcProvider(RPC[chain]);
    const multicall = new ethers.Contract(MULTICALLS[chain], MulticallAbi, provider);
    
    // TODO: split query in batches?
    const query = filtered.map(p => [p.address, p.lp0.address, p.lp1.address]);
    const buf = await multicall.getLpInfo(query);
    
    // Merge fetched data
    for (let i = 0; i < filtered.length; i++) {
      filtered[i].totalSupply = new BigNumber(buf[i * 3 + 0].toString());
      filtered[i].lp0.balance = new BigNumber(buf[i * 3 + 1].toString());
      filtered[i].lp1.balance = new BigNumber(buf[i * 3 + 2].toString());

      // price calc optimization
      filtered[i].lp0.normalizedBalance = filtered[i].lp0.balance.div(filtered[i].lp0.decimals);
      filtered[i].lp1.normalizedBalance = filtered[i].lp1.balance.div(filtered[i].lp1.decimals);
    }

    const unsolved = filtered.slice();
    let solving = true;
    while (solving) {
      solving = false;

      for (let i = unsolved.length - 1; i >= 0; i--) {
        const pool = unsolved[i];
        
        let knownToken, unknownToken;
        if(pool.lp0.oracleId in tokenPrices) {
          knownToken = pool.lp0;
          unknownToken = pool.lp1;

        } else if (pool.lp1.oracleId in tokenPrices) {
          knownToken = pool.lp1;
          unknownToken = pool.lp0;
        
        } else { 
          console.log('unsolved: ', pool.lp0.oracleId, pool.lp1.oracleId);
          continue; 
        }

        tokenPrices[unknownToken.oracleId] = calcTokenPrice(
          tokenPrices[knownToken.oracleId], knownToken, unknownToken
        );

        poolPrices[pool.name] = calcLpPrice(pool, tokenPrices);

        unsolved.splice(i, 1);
        solving = true;
      }
    }
  }
  
  return {
    poolPrices: poolPrices,
    tokenPrices: tokenPrices,
  };
};

module.exports = { fetchAmmPrices };