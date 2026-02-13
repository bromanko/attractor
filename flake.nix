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
        packages.default = pkgs.buildNpmPackage {
          pname = "attractor";
          version = "0.1.0";
          src = ./.;
          npmDepsHash = "sha256-RaBumTkFYyfxk0hx4+YYogirsrcMyg9ZC8yyqxgRxXA=";
          buildPhase = ''
            npm run build
          '';
          installPhase = ''
            mkdir -p $out/lib/attractor $out/bin
            cp -r dist $out/lib/attractor/
            cp -r node_modules $out/lib/attractor/
            cp package.json $out/lib/attractor/

            cat > $out/bin/attractor <<EOF
            #!/usr/bin/env bash
            exec ${pkgs.nodejs_22}/bin/node $out/lib/attractor/dist/cli.js "\$@"
            EOF
            chmod +x $out/bin/attractor
          '';

          meta = with pkgs.lib; {
            description = "DOT-based pipeline runner for AI workflows";
            license = licenses.asl20;
            mainProgram = "attractor";
          };
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            corepack_22
            selfci-pkg
            graph-easy
          ];

          shellHook = ''
            echo "attractor dev shell — node $(node --version), selfci $(selfci --version 2>/dev/null || echo 'available')"
          '';
        };
      });
}
