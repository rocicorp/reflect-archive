export default function Roci({rotation}: {rotation: number}) {
  const style = {
    transform: `rotate(${rotation}deg)`,
  };

  return (
    <svg
      width="150"
      height="150"
      viewBox="0 0 150 150"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={style}
    >
      <path d="M143.714 90.8145L118.774 115.755L78.2063 75.1875L117.825 35.5693V55.5535L119.157 54.9653C127.263 51.3883 137.076 52.9218 143.714 59.5604C152.345 68.191 152.345 82.1842 143.714 90.8145Z" fill="#FF9900"/>
      <path d="M55.5535 117.825H35.5693L75.1876 78.2062L115.755 118.774L90.8146 143.714C82.1843 152.345 68.191 152.345 59.5605 143.714C52.9219 137.076 51.3883 127.263 54.9654 119.157L55.5535 117.825Z" fill="#1D9DE5"/>
      <path d="M94.8217 32.5503H114.805L75.1874 72.1684L34.6199 31.601L59.5604 6.66046C68.191 -1.97017 82.1842 -1.97014 90.8144 6.66046C97.4534 13.2991 98.9864 23.1123 95.4097 31.2176L94.8217 32.5503Z" fill="#5FE8FF"/>
      <path d="M31.601 34.6199L6.66046 59.5604C-1.97017 68.1911 -1.97014 82.1843 6.66046 90.8145C13.2991 97.4535 23.1123 98.9865 31.2176 95.4098L32.5503 94.8218V114.806L72.1684 75.1875L31.601 34.6199Z" fill="#FC49AB"/>
    </svg>
  );
}
