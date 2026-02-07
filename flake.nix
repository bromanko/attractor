{
  description = "Attractor – DOT-based pipeline runner for AI workflows";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    selfci.url = "git+https://radicle.dpc.pw/z2tDzYbAXxTQEKTGFVwiJPajkbeDU.git";
  };

  outputs = { self, nixpkgs, flake-utils, selfci }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        selfci-pkg = selfci.packages.${system}.default;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            corepack_22
            selfci-pkg
          ];

          shellHook = ''
            echo "attractor dev shell — node $(node --version), selfci $(selfci --version 2>/dev/null || echo 'available')"
          '';
        };
      });
}
