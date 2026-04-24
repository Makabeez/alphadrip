module.exports = {
  apps: [
    {
      name: "alphadrip-emitter",
      script: "npx",
      args: "tsx server.ts",
      cwd: __dirname,
      env: {
        PORT: "3005",
        SELLER_WALLET_ADDRESS: "0x9747B4B2F4EcB59C4055c45CDA0Ae0D44A04eD14",
        SELLER_PRIVATE_KEY: "0x04479bba594e4dac90e059d34af6e7ae71e1c6a736ea30a74298dd793e7314a7"
      },
      max_restarts: 5,
      min_uptime: "10s"
    }
  ]
};