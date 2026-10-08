import type { BotState } from '../types';

interface BalanceCardsProps {
  state: BotState | null;
}

interface BalanceCardProps {
  icon: string;
  label: string;
  value: string;
  subLabel?: string;
  gradient: string;
  iconBg: string;
}

function BalanceCard({ icon, label, value, subLabel, gradient, iconBg }: BalanceCardProps) {
  return (
    <div className={`glass-card glass-card-hover rounded-lg p-3 ${gradient}`}>
      <div className="flex items-center gap-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-base ${iconBg}`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider truncate">
            {label}{subLabel && <span className="text-gray-600 normal-case"> · {subLabel}</span>}
          </div>
          {/* étiquette secondaire sous le titre (et non plus en colonne à droite) : la valeur
              a toute la largeur et n'est plus tronquée (« $1,0… ») */}
          <div className="text-base font-bold font-mono text-white whitespace-nowrap">
            {value}
          </div>
        </div>
      </div>
    </div>
  );
}

export function BalanceCards({ state }: BalanceCardsProps) {
  const matic = state?.maticBalance ?? 0;
  const usdc = state?.usdcBalance ?? 0;
  const usdce = state?.usdcEBalance ?? 0;
  const total = usdc + usdce;

  // Au-delà de 1 000, sans décimales : sinon la carte tronque (« $1,0… »).
  const formatCurrency = (value: number, decimals: number = 2) => {
    const d = Math.abs(value) >= 1000 ? 0 : decimals;
    return value.toLocaleString(undefined, {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  };

  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
      <BalanceCard
        icon="💜"
        label="MATIC"
        value={formatCurrency(matic, 4)}
        subLabel="Gas"
        gradient="bg-gradient-to-br from-purple-500/10 to-purple-500/5"
        iconBg="bg-purple-500/20"
      />
      <BalanceCard
        icon="💵"
        label="USDC"
        value={`$${formatCurrency(usdc)}`}
        subLabel="Bridged"
        gradient="bg-gradient-to-br from-green-500/10 to-green-500/5"
        iconBg="bg-green-500/20"
      />
      <BalanceCard
        icon="💰"
        label="USDC.e"
        value={`$${formatCurrency(usdce)}`}
        subLabel="Native"
        gradient="bg-gradient-to-br from-blue-500/10 to-blue-500/5"
        iconBg="bg-blue-500/20"
      />
      <BalanceCard
        icon="🏦"
        label="Total"
        value={`$${formatCurrency(total)}`}
        subLabel="Capital"
        gradient="bg-gradient-to-br from-yellow-500/10 to-orange-500/5"
        iconBg="bg-yellow-500/20"
      />
    </div>
  );
}
